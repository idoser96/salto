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
import { ChangeValidator, ElemID, getChangeData, isInstanceElement, ReadOnlyElementsSource } from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import { ACCOUNT_FEATURES_TYPE_NAME, CUSTOM_STATUS_TYPE_NAME, ZENDESK } from '../constants'

const log = logger(module)
const errorMsg = (reason: string): string => `Failed to run customStatusesEnabledValidator because ${reason}`

/**
  * If this function fails to identify whether custom statuses are enabled
* it will log an error and return true to skip the validator.
  */
const areCustomStatusesEnabled = async (
  elementSource?: ReadOnlyElementsSource
): Promise<boolean> => {
  if (elementSource === undefined) {
    log.error(errorMsg('no element source was provided'))
    return true
  }

  const accountFeatures = await elementSource.get(
    new ElemID(
      ZENDESK,
      ACCOUNT_FEATURES_TYPE_NAME,
      'instance',
      ElemID.CONFIG_NAME
    )
  )

  if (accountFeatures === undefined) {
    log.error(errorMsg('no account features'))
    return true
  }

  if (!isInstanceElement(accountFeatures)) {
    log.error(errorMsg('account features is not an instance element'))
    return true
  }

  const customStatusesEnabled = accountFeatures.value.custom_statuses_enabled
  if (customStatusesEnabled === undefined) {
    log.error(errorMsg('no "custom_statuses_enabled" field'))
    return true
  }

  return customStatusesEnabled.enabled
}

/**
 * Checks that the custom statuses Zendesk feature is enabled before changing
 * instances of type zendesk.custom_status.
 */
export const customStatusesEnabledValidator: ChangeValidator = async (
  changes,
  elementSource
) => {
  // If custom statuses are enabled (or if we failed to check if custom statuses
  // are enabled) there's no need to check anything else.
  if (await areCustomStatusesEnabled(elementSource)) return []

  return changes
    .filter(change => getChangeData(change).elemID.typeName === CUSTOM_STATUS_TYPE_NAME)
    .map(getChangeData)
    .map(instance => ({
      elemID: instance.elemID,
      severity: 'Error',
      message: 'Custom statuses are not enabled.',
      detailedMessage: 'Cannot deploy custom statuses when they are not enabled in the Zendesk account.',
    }))
}
