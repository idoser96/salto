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
  ChangeError,
  ChangeValidator,
  getChangeData, InstanceElement,
  isAdditionChange,
  isInstanceChange, isModificationChange,
  isRemovalChange, ModificationChange,
} from '@salto-io/adapter-api'
import { detailedCompare } from '@salto-io/adapter-utils'
import { WEBHOOK_TYPE_NAME } from '../constants'

const createExternalSourceWebhookChangeWarning = (webhook: InstanceElement): ChangeError => ({
  elemID: webhook.elemID,
  severity: 'Warning',
  message: 'Change of a webhook that was installed by an external app',
  detailedMessage: 'If you edit this webhook, the app that created it might not work as intended.',
})

const createDeactivationWarning = (webhook: InstanceElement): ChangeError => ({
  elemID: webhook.elemID,
  severity: 'Warning',
  message: 'Deactivation of a webhook that was installed by an external app',
  detailedMessage: 'If you deactivate this webhook, the app that created it might not work as intended. You\'ll need to reactivate it to use it again.',
})

const createExternalSourceChangeError = (webhook: InstanceElement): ChangeError => ({
  elemID: webhook.elemID,
  severity: 'Error',
  message: 'Illegal webhook modification',
  detailedMessage: 'Cannot modify \'external_source\' or \'signing_secret\' fields of a webhook',
})

const handleModificationChanges = (changes: ModificationChange<InstanceElement>[]): ChangeError[] => {
  const errors: ChangeError[] = []
  changes.forEach(change => {
    const detailedChanges = detailedCompare(change.data.before, change.data.after)

    // It's impossible to change some fields of a webhook using Zendesk's api
    if (detailedChanges.some(detailedChange => detailedChange.id.getFullName().includes('external_source'))
        || detailedChanges.some(detailedChange => detailedChange.id.getFullName().includes('signing_secret'))) {
      errors.push(createExternalSourceChangeError(change.data.after))
      return
    }

    const inactivationChange = detailedChanges.filter(isModificationChange).find(detailedChange => detailedChange.id.name === 'status')
    const wasDeactivated = inactivationChange && inactivationChange.data.before === 'active' && inactivationChange.data.after === 'inactive'
    if (wasDeactivated) {
      errors.push(createDeactivationWarning(change.data.after))
    }

    // There is a different warning for changes that are not deactivation, so if there is another change - warn it too
    if (!wasDeactivated || detailedChanges.length > 1) {
      errors.push(createExternalSourceWebhookChangeWarning(change.data.after))
    }
  })
  return errors
}

const createAdditionError = (webhooks: InstanceElement[]): ChangeError[] =>
  webhooks.map(webhook => {
    // If we know the app that installed the webhook, we can give a more specific error message
    const appName = webhook.value.external_source.data.installation_id?.elemID?.name
    const appNameMessage = appName ? ` '${appName}'` : ''
    return {
      elemID: webhook.elemID,
      severity: 'Error',
      message: 'Installation of a webhook that was installed by an external app',
      detailedMessage: `This webhook was installed by the external app${appNameMessage}. In order to add it, please install that app.`,
    }
  })

const createRemovalErrorMessage = (webhooks: InstanceElement[]): ChangeError[] =>
  webhooks.map(webhook => {
    // If we know the app that installed the webhook, we can give a more specific error message
    const appName = webhook.value.external_source.data.installation_id?.elemID?.name
    const appNameMessage = appName ? ` '${appName}'` : ''
    return {
      elemID: webhook.elemID,
      severity: 'Error',
      message: 'Removal of a webhook that was installed by an external app',
      detailedMessage: `This webhook was installed by the external app${appNameMessage}. In order to remove it, please uninstall that app.`,
    }
  })

export const externalSourceWebhook: ChangeValidator = async changes => {
  const externalSourceWebhookChanges = changes.filter(isInstanceChange)
    .filter(change => getChangeData(change).elemID.typeName === WEBHOOK_TYPE_NAME)
    .filter(change => getChangeData(change).value.external_source)

  return [
    createAdditionError(externalSourceWebhookChanges.filter(isAdditionChange).map(getChangeData)),
    createRemovalErrorMessage(externalSourceWebhookChanges.filter(isRemovalChange).map(getChangeData)),
    handleModificationChanges(externalSourceWebhookChanges.filter(isModificationChange)),
  ].flat()
}
