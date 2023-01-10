/*
*                      Copyright 2022 Salto Labs Ltd.
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
  Change,
  getChangeData,
  InstanceElement,
  isInstanceChange,
  isRemovalChange,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { FilterCreator } from '../filter'
import { GROUP_TYPE_NAME } from '../constants'
import { deployChange, deployChanges } from '../deployment'

/**
 Deploys removal changes last, in case a default group is removed and another one was set (SALTO-3183)
 */
const filterCreator: FilterCreator = ({ config, client }) => ({
  deploy: async (changes: Change<InstanceElement>[]) => {
    const [groupChanges, leftoverChanges] = _.partition(
      changes,
      change => isInstanceChange(change) && getChangeData(change).elemID.typeName === GROUP_TYPE_NAME
    )

    const [removalChanges, otherChanges] = _.partition(
      groupChanges,
      change => isRemovalChange(change)
    )

    const otherDeployResults = await deployChanges(
      otherChanges,
      async change => {
        await deployChange(change, client, config.apiDefinitions)
      }
    )
    const removalDeployResults = await deployChanges(
      removalChanges,
      async change => {
        await deployChange(change, client, config.apiDefinitions)
      }
    )


    return {
      deployResult: {
        appliedChanges: [
          ...otherDeployResults.appliedChanges,
          ...removalDeployResults.appliedChanges,
        ],
        errors: [
          ...otherDeployResults.errors,
          ...removalDeployResults.errors,
        ],
      },
      leftoverChanges,
    }
  },
})

export default filterCreator
