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
import {
  BuiltinTypes, CORE_ANNOTATIONS,
  Element,
  ElemID, getChangeData,
  InstanceElement, isAdditionOrModificationChange, isInstanceChange,
  isInstanceElement,
  ListType,
  ObjectType, ReferenceExpression, SaltoElementError, Value,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { getParent, getParents, inspectValue } from '@salto-io/adapter-utils'
import { collections } from '@salto-io/lowerdash'
import { elements as elementsUtils } from '@salto-io/adapter-components'
import { FilterCreator } from '../../filter'
import {
  CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME,
  CUSTOM_OBJECT_FIELD_TYPE_NAME,
  CUSTOM_OBJECT_TYPE_NAME,
  ZENDESK,
} from '../../constants'

const { RECORDS_PATH } = elementsUtils
const { makeArray } = collections.array

const ORDER_FIELD = `${CUSTOM_OBJECT_FIELD_TYPE_NAME}s`

const customObjectFieldsOrderType = new ObjectType({
  elemID: new ElemID(ZENDESK, CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME),
  fields: {
    [ORDER_FIELD]: { refType: new ListType(BuiltinTypes.NUMBER) },
  },
  path: [ZENDESK, elementsUtils.TYPES_PATH, CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME],
})

/**
 Creates an order object for each custom object
 The fields are returned from the api by order, so we save it to be able to properly reorder them on deploy
 This is needed because two fields can have the same positions, and then be sorted by non multi-env fields
 */
const customObjectFieldsOrderFilter: FilterCreator = ({ client }) => ({
  name: 'customObjectFieldsOrderFilter',
  onFetch: async (elements: Element[]) => {
    const customObjectFields = elements
      .filter(isInstanceElement)
      .filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_FIELD_TYPE_NAME)
    const customObjectsByFullName = _.keyBy(
      elements.filter(isInstanceElement).filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_TYPE_NAME),
      element => element.elemID.getFullName()
    )

    const customObjectFieldsByParentName = _.groupBy(
      customObjectFields.filter(field => getParents(field).length === 1),
      field => getParent(field).elemID.getFullName()
    )

    if (!_.isEmpty(customObjectFieldsByParentName)) {
      elements.push(customObjectFieldsOrderType)
    }

    Object.entries(customObjectFieldsByParentName).forEach(([parentName, fields]) => {
      const parent = customObjectsByFullName[parentName]
      const instanceName = `${parent.elemID.name}_fields_order`
      const orderInstance = new InstanceElement(
        instanceName,
        customObjectFieldsOrderType,
        {
          [ORDER_FIELD]: fields.map(field => new ReferenceExpression(field.elemID, field)),
        },
        [ZENDESK, RECORDS_PATH, CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME, instanceName],
        {
          [CORE_ANNOTATIONS.PARENT]: parent
            ? new ReferenceExpression(parent.elemID, parent)
            : undefined,
        }
      )
      elements.push(orderInstance)
    })
  },
  deploy: async changes => {
    const [relevantChanges, leftoverChanges] = _.partition(
      changes,
      change =>
        isInstanceChange(change)
        && isAdditionOrModificationChange(change)
        && getChangeData(change).elemID.typeName === CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME
    )

    const deployResultsPromises = relevantChanges
      .filter(isInstanceChange) // used to type check
      .map(async change => {
        const customObjectFieldOrder = getChangeData(change)
        const parentKey = getParents(customObjectFieldOrder)[0].key
        if (parentKey === undefined) {
          return {
            change,
            error: 'parent key is undefined',
          }
        }
        const fieldsIds = customObjectFieldOrder.value[ORDER_FIELD]
          .filter((field: Value) => _.isPlainObject(field) && _.isNumber(field.id))
          .map((field: { id: number }) => field.id.toString())
        try {
          await client.put({
            url: `/api/v2/custom_objects/${parentKey}/fields/reorder`,
            data: {
              custom_object_field_ids: fieldsIds,
            },
          })
          return { change }
        } catch (e) {
          return {
            change,
            error: `reorder request failed, ${inspectValue(makeArray(e.response?.data.error))}`,
          }
        }
      })

    const deployResults = await Promise.all(deployResultsPromises)
    const [successes, errors] = _.partition(deployResults, result => result.error === undefined)

    return {
      deployResult: {
        appliedChanges: successes.map(success => success.change),
        errors: errors.map(({ change, error }): SaltoElementError => ({
          elemID: getChangeData(change).elemID,
          severity: 'Error',
          message: error ?? '', // We checked that error is defined in the errors partition
        })),
      },
      leftoverChanges,
    }
  },
})

export default customObjectFieldsOrderFilter
