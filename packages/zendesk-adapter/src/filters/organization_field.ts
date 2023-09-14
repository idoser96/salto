/*
*                      Copyright 2023 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import _ from 'lodash'
import {
  Change,
  getChangeData,
  InstanceElement,
  Value,
} from '@salto-io/adapter-api'
import { FilterCreator } from '../filter'
import { addIdsToChildrenUponAddition, deployChange, deployChanges } from '../deployment'
import { API_DEFINITIONS_CONFIG } from '../config'
import { createAdditionalParentChanges } from './utils'
import { ORG_FIELD_TYPE_NAME } from '../constants'

export const CUSTOM_FIELD_OPTIONS_FIELD_NAME = 'custom_field_options'
export const ORG_FIELD_OPTION_TYPE_NAME = 'organization_field__custom_field_options'

type CustomFieldOption = {
  // eslint-disable-next-line camelcase
  raw_name: string
  name?: string
}

const getParentsChildren = (parentChanges: Change<InstanceElement>[]): CustomFieldOption[] =>
  parentChanges.flatMap(getChangeData)
    .filter(parent => _.isArray(parent.value[CUSTOM_FIELD_OPTIONS_FIELD_NAME]))
    .flatMap(parent => parent.value[CUSTOM_FIELD_OPTIONS_FIELD_NAME]
      .filter((child: Value) => child.raw_name !== undefined))


const filterCreator: FilterCreator = ({ config, client }) => ({
  name: 'organizationFieldFilter',
  deploy: async (changes: Change<InstanceElement>[]) => {
    const [relevantChanges, leftoverChanges] = _.partition(
      changes,
      change => [ORG_FIELD_TYPE_NAME, ORG_FIELD_OPTION_TYPE_NAME]
        .includes(getChangeData(change).elemID.typeName),
    )
    const [parentChanges, childrenChanges] = _.partition(
      relevantChanges,
      change => getChangeData(change).elemID.typeName === ORG_FIELD_TYPE_NAME,
    )

    const additionalParentChanges = parentChanges.length === 0 && childrenChanges.length > 0
      ? await createAdditionalParentChanges(childrenChanges)
      : []
    if (additionalParentChanges === undefined) {
      return {
        deployResult: {
          appliedChanges: [],
          errors: childrenChanges
            .map(getChangeData)
            .map(e => ({
              message: `Failed to update ${e.elemID.getFullName()} since it has no valid parent`,
              severity: 'Error',
              elemID: e.elemID,
            })),
        },
        leftoverChanges,
      }
    }

    const allParentChanges = parentChanges.concat(additionalParentChanges)

    // This is here and not in preDeploy because we want to copy the final value after preDeploy processing
    getParentsChildren(allParentChanges)
      .forEach(child => {
      // Zendesk API automatically translates the dynamic_content value of raw_name to name
        child.name = child.raw_name
      })

    const deployResult = await deployChanges(
      allParentChanges,
      async change => {
        const response = await deployChange(
          change, client, config.apiDefinitions
        )
        return addIdsToChildrenUponAddition({
          response,
          parentChange: change,
          childrenChanges,
          apiDefinitions: config[API_DEFINITIONS_CONFIG],
          childFieldName: CUSTOM_FIELD_OPTIONS_FIELD_NAME,
          childUniqueFieldName: 'value',
        })
      }
    )

    getParentsChildren(allParentChanges)
      .forEach(child => {
        // Zendesk API automatically translates the dynamic_content value of raw_name to name
        delete child.name
      })

    const additionalParentIds = new Set(
      additionalParentChanges.map(getChangeData).map(e => e.elemID.getFullName())
    )
    return {
      deployResult: {
        errors: deployResult.errors,
        appliedChanges: deployResult.appliedChanges
          .filter(change => !additionalParentIds.has(getChangeData(change).elemID.getFullName())),
      },
      leftoverChanges,
    }
  },
})

export default filterCreator
