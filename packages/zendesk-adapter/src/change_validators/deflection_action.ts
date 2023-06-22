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
  ChangeValidator, ElemID, getChangeData, isAdditionOrModificationChange,
  isInstanceChange, Value, Values,
} from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import {
  AUTOMATION_TYPE_NAME,
  MACRO_TYPE_NAME,
  TRIGGER_TYPE_NAME,
  ZENDESK,
} from '../constants'
import { ACCOUNT_SETTING_TYPE_NAME } from '../filters/account_settings'

const log = logger(module)

const TYPES_WITH_ACTIONS = [TRIGGER_TYPE_NAME, MACRO_TYPE_NAME, AUTOMATION_TYPE_NAME]
export const DEFLECTION_TYPE = 'deflection'

type SettingsInstanceWithAutomaticAnswers = {
  value: {
    // eslint-disable-next-line camelcase
    active_features: {
      // eslint-disable-next-line camelcase
      automatic_answers: boolean
    }
  }
}

const isValidSettings = (instance: Value): instance is SettingsInstanceWithAutomaticAnswers =>
  _.isBoolean(instance?.value?.active_features?.automatic_answers)

const isDeflectionAction = (action: Values): boolean =>
  _.isPlainObject(action) && action.field === DEFLECTION_TYPE

/**
 * TODODODOD
 */
export const deflectionActionValidator: ChangeValidator = async (
  changes, elementSource
) => {
  const relevantInstances = changes
    .filter(isAdditionOrModificationChange)
    .filter(isInstanceChange)
    .map(getChangeData)
    .filter(instance => TYPES_WITH_ACTIONS.includes(instance.elemID.typeName))
    .filter(instance => (instance.value.actions ?? []).some(isDeflectionAction))

  if (relevantInstances.length === 0) {
    return []
  }

  if (elementSource === undefined) {
    log.error('Failed to run deflectionActionValidator because element source is undefined')
    return []
  }

  const accountSettings = await elementSource.get(
    new ElemID(ZENDESK, ACCOUNT_SETTING_TYPE_NAME, 'instance', ElemID.CONFIG_NAME)
  )

  if (!isValidSettings(accountSettings)) {
    log.error('Failed to run deflectionActionValidator because account settings instance is invalid')
    return []
  }

  const isDeflectionOn = accountSettings.value.active_features.automatic_answers

  // TODO: talk to tomer about the message
  return isDeflectionOn ? [] : relevantInstances.map(instance => ({
    elemID: instance.elemID,
    severity: 'Error',
    message: 'Cannot change this element since one of its action types is not supported',
    detailedMessage: `Action field '${DEFLECTION_TYPE}' is not supported, please turn on automatic answers in your account settings`,
  }))
}
