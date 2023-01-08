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
  ChangeValidator, getChangeData,
  isInstanceChange, isRemovalChange,
} from '@salto-io/adapter-api'
import { GROUP_TYPE_NAME } from '../constants'

export const defaultGroupDeletion: ChangeValidator = async changes => (
  changes
    .filter(isInstanceChange).filter(isRemovalChange).map(getChangeData)
    .filter(instance => instance.elemID.typeName === GROUP_TYPE_NAME)
    .filter(group => group.value.default === true)
    .map(group => ({
      elemID: group.elemID,
      severity: 'Error',
      message: 'Default group cannot be deleted',
      detailedMessage: `Group ${group.value.nmae} is marked as default and therefore cannot be deleted`,
    }))
)
