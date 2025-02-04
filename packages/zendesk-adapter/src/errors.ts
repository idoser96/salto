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
import _ from 'lodash'
import { EOL } from 'os'
import { client as clientUtils } from '@salto-io/adapter-components'
import { safeJsonStringify } from '@salto-io/adapter-utils'

export const getZendeskError = (fullName: string, error: Error): Error => {
  if (!(error instanceof clientUtils.HTTPError)) {
    return error
  }
  const baseErrorMessage = `Deployment of ${fullName} failed: ${error}`
  const errorMessage = (!_.isPlainObject(error.response.data))
    ? baseErrorMessage
    : [baseErrorMessage, safeJsonStringify(error.response.data, undefined, 2)].join(EOL)
  return new Error(errorMessage)
}
