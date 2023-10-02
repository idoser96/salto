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
  isInstanceElement,
  Element,
  InstanceElement,
  ReferenceExpression,
  Value,
  TemplateExpression,
  isReferenceExpression,
  Change,
  isAdditionOrModificationChange,
  getChangeData, ElemID,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { references as referencesUtils, client as clientUtils } from '@salto-io/adapter-components'
import { collections } from '@salto-io/lowerdash'
import { logger } from '@salto-io/logging'
import { FilterCreator } from '../../filter'
import {
  CUSTOM_OBJECT_FIELD_OPTIONS_TYPE_NAME,
  CUSTOM_FIELD_OPTIONS_FIELD_NAME,
  CUSTOM_OBJECT_FIELD_TYPE_NAME,
  CUSTOM_OBJECT_TYPE_NAME,
  TICKET_FIELD_TYPE_NAME,
  TRIGGER_TYPE_NAME,
  ZENDESK,
} from '../../constants'
import { DEPLOY_CONFIG, FETCH_CONFIG } from '../../config'
import {
  LOOKUP_REGEX,
  RELATIONSHIP_FILTER_REGEX,
  transformCustomObjectLookupField,
  transformFilterField,
} from './utils'
import { paginate } from '../../client/pagination'
import { getIdByEmail, getUserFallbackValue, getUsers } from '../../user_utils'

const { makeArray } = collections.array
const { createMissingInstance } = referencesUtils
const { createPaginator } = clientUtils

const log = logger(module)

const USER_TYPE = 'user'

const relationTypeToType = (relationshipTargetType: Value): string => {
  if (!_.isString(relationshipTargetType)) {
    return 'unknown'
  }

  if (relationshipTargetType.startsWith('zen:custom_object')) {
    return CUSTOM_FIELD_OPTIONS_FIELD_NAME
  }
  switch (relationshipTargetType) {
    case 'zen:user':
      return USER_TYPE
    case 'zen:organization':
      return 'organization'
    case 'zen:ticket':
      return TICKET_FIELD_TYPE_NAME
    default:
      return 'unknown'
  }
}

// Conditions and filters may also have a reference in their value field
const transformFilterValue = ({
  customObjectField,
  filter,
  enableMissingReferences,
  instancesById,
  usersById,
}: {
  customObjectField?: InstanceElement
  // eslint-disable-next-line camelcase
  filter: { operator: string; value?: string | number | ReferenceExpression; is_user_value?: boolean }
  enableMissingReferences: boolean
  instancesById: Record<string, InstanceElement>
  usersById: Record<string, string>
}): void => {
  if (customObjectField === undefined
    // These are special cases where the value is a reference to an element
    || !['is', 'is_not'].includes(filter.operator)
    || filter.value === undefined || isReferenceExpression(filter.value)
    || !['dropdown', 'lookup'].includes(customObjectField.value.type)) {
    return
  }

  const referencedElement = instancesById[filter.value] ?? usersById[filter.value]
  // lookup value type is based on the relationship_target_type of the custom object field
  const referencesElementType = customObjectField.value.type === 'lookup'
    ? relationTypeToType(customObjectField.value.relationship_target_type)
    : CUSTOM_OBJECT_FIELD_OPTIONS_TYPE_NAME

  // We need to mark values that contains user, so we can handle them differently during deploy
  if (referencesElementType === USER_TYPE) {
    filter.is_user_value = true
  }

  if (referencedElement === undefined) {
    if (enableMissingReferences) {
      if (referencesElementType === USER_TYPE) {
        // We don't want to create a missing user instance, because we have default have a fallback feature
        return
      }
      const missingInstance = createMissingInstance(
        ZENDESK,
        referencesElementType,
        filter.value.toString(),
      )
      filter.value = new ReferenceExpression(missingInstance.elemID)
    }
    return
  }

  filter.value = _.isString(referencedElement)
    ? referencedElement // This is a user
    : new ReferenceExpression(referencedElement.elemID, referencedElement) // This is anything else
}

type CustomObjectAction = {
  field: string
  value: Array<string | TemplateExpression> | string | TemplateExpression
}

const isRelevantAction = (action: Value): action is CustomObjectAction =>
  _.isPlainObject(action)
  && _.isString(action.field)
  // makeArray to catch both cases where value is a string or an array of strings
  && makeArray(action.value).every(_.isString)
  && LOOKUP_REGEX.test(makeArray(action.value)[0])

type CustomObjectCondition = {
  field: string | TemplateExpression
  operator: string
  value?: string | ReferenceExpression
  // eslint-disable-next-line camelcase
  is_user_value?: boolean
}

const isCondition = (value: Value): value is CustomObjectCondition =>
  _.isPlainObject(value)
  && _.isString(value.field)
  && _.isString(value.operator)
  && (value.value === undefined || _.isString(value.value))

const isRelevantCondition = (condition: Value): boolean =>
  isCondition(condition)
  && _.isString(condition.field) && LOOKUP_REGEX.test(condition.field)

const isRelevantFilter = (filter: Value): boolean =>
  isCondition(filter)
  && _.isString(filter.field) && RELATIONSHIP_FILTER_REGEX.test(filter.field)


const transformTriggerValue = ({
  trigger,
  instancesById,
  usersById,
  customObjectsByKey,
  enableMissingReferences,
}:
{
  trigger: InstanceElement
  instancesById: Record<string, InstanceElement>
  usersById: Record<string, string>
  customObjectsByKey: Record<string, InstanceElement>
  enableMissingReferences: boolean
}): void => {
  const transformArgs = { instancesById, customObjectsByKey, enableMissingReferences }

  const actions = _.isArray(trigger.value.actions) && trigger.value.actions.every(action => _.isPlainObject(action))
    ? trigger.value.actions
    : []
  actions
    .filter(isRelevantAction)
    .forEach(action => {
      const value = makeArray(action.value)[0]
      // always false, used for type casting
      if (!_.isString(value)) {
        return
      }
      const { result } = transformCustomObjectLookupField({ field: value, ...transformArgs })
      // notification_user is a special case, value is an array and the first element is the custom_object field
      if (action.field === 'notification_user' && _.isArray(action.value)) {
        action.value[0] = result
      } else {
        action.value = result
      }
    })

  const conditions = [
    ..._.isArray(trigger.value.conditions?.all) ? trigger.value.conditions?.all : [],
    ..._.isArray(trigger.value.conditions?.any) ? trigger.value.conditions?.any : [],
  ]
  conditions
    .filter(isRelevantCondition)
    .forEach(condition => {
      // always false, used for type casting
      if (!_.isString(condition.field)) {
        return
      }
      const { result, ticketField, customObjectField } = transformCustomObjectLookupField({
        field: condition.field,
        ...transformArgs,
      })
      condition.field = result

      if (ticketField !== undefined) {
        transformFilterValue({
          customObjectField,
          filter: condition,
          enableMissingReferences,
          instancesById,
          usersById,
        })
      }
    })
}

const transformTicketAndCustomObjectFieldValue = ({
  instance,
  instancesById,
  usersById,
  customObjectsByKey,
  enableMissingReferences,
}:
{
  instance: InstanceElement
  instancesById: Record<string, InstanceElement>
  usersById: Record<string, string>
  customObjectsByKey: Record<string, InstanceElement>
  enableMissingReferences: boolean
}): void => {
  const relevantRelationshipFilters = [
    ..._.isArray(instance.value.relationship_filter?.all) ? instance.value.relationship_filter?.all : [],
    ..._.isArray(instance.value.relationship_filter?.any) ? instance.value.relationship_filter?.any : [],
  ].filter(isRelevantFilter)

  relevantRelationshipFilters.forEach((filter: CustomObjectCondition) => {
    if (!_.isString(filter.field)) {
      return
    }

    const { result, customObjectField } = transformFilterField(
      filter.field, enableMissingReferences, customObjectsByKey
    )
    filter.field = result

    transformFilterValue({
      customObjectField,
      filter,
      enableMissingReferences,
      instancesById,
      usersById,
    })
  })
}

const filterUserConditions = (conditions: Value, instancePath: string[], filterCondition: (cond: Value) => boolean):
  {
  path: string[]
  condition: CustomObjectCondition
}[] => {
  const allConditions = _.isArray(conditions?.all) ? conditions?.all : []
  const anyConditions = _.isArray(conditions?.any) ? conditions?.any : []

  return [
    ...allConditions.map((condition: Value, i: number) => ({ path: [...instancePath, 'all', i], condition })),
    ...anyConditions.map((condition: Value, i: number) => ({ path: [...instancePath, 'any', i], condition })),
  ]
    .filter(({ condition }) => filterCondition(condition))
    .filter(({ condition }) => condition.is_user_value)
}

const getUserConditions = (changes: Change<InstanceElement>[]):
  {
    path: string[]
    condition: CustomObjectCondition
  }[] => {
  const instances = changes
    .filter(isAdditionOrModificationChange)
    .map(getChangeData)

  const triggers = instances.filter(instance => instance.elemID.typeName === TRIGGER_TYPE_NAME)
  const ticketFields = instances.filter(instance => instance.elemID.typeName === TICKET_FIELD_TYPE_NAME)
  const customObjectFields = instances.filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_FIELD_TYPE_NAME)

  const triggerConditions = triggers.flatMap(trigger => filterUserConditions(
    trigger.value.conditions,
    trigger.elemID.getFullNameParts().concat('conditions'),
    isRelevantCondition
  ))

  const ticketAndCustomObjectFieldFilters = ticketFields.concat(customObjectFields).flatMap(field =>
    filterUserConditions(
      field.value.relationship_filter,
      field.elemID.getFullNameParts().concat('relationship_filter'),
      isRelevantFilter
    ))

  return triggerConditions.concat(ticketAndCustomObjectFieldFilters)
}

/**
 *  Convert custom object field values to reference expressions
 *  preDeploy handles values that are users, including fallback user
 *  onDeploy reverts the preDeploy
 */
const customObjectFieldsFilter: FilterCreator = ({ config, client }) => {
  const userPathToOriginalValue: Record<string, string> = {}
  const paginator = createPaginator({
    client,
    paginationFuncCreator: paginate,
  })
  return {
    name: 'customObjectFieldOptionsFilter',
    onFetch: async (elements: Element[]) => {
      const enableMissingReferences = config[FETCH_CONFIG].enableMissingReferences ?? false

      const instances = elements.filter(isInstanceElement)

      // It is possible to key all instance by id because the internal Id is unique across all types (SALTO-4805)
      const usersById = await getIdByEmail(paginator)
      const instancesById = _.keyBy(
        instances.filter(instance => _.isNumber(instance.value.id)),
        instance => _.parseInt(instance.value.id)
      )

      const customObjectsByKey = _.keyBy(
        instances
          .filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_TYPE_NAME)
          .filter(instance => _.isString(instance.value.key)),
        instance => String(instance.value.key)
      )

      const triggers = instances.filter(instance => instance.elemID.typeName === TRIGGER_TYPE_NAME)
      const ticketFields = instances.filter(instance => instance.elemID.typeName === TICKET_FIELD_TYPE_NAME)
      const customObjectFields = instances.filter(inst => inst.elemID.typeName === CUSTOM_OBJECT_FIELD_TYPE_NAME)

      triggers.forEach(
        trigger => transformTriggerValue({
          trigger,
          customObjectsByKey,
          enableMissingReferences,
          instancesById,
          usersById,
        })
      )
      ticketFields.concat(customObjectFields).forEach(
        instance => transformTicketAndCustomObjectFieldValue({
          instance,
          customObjectsByKey,
          enableMissingReferences,
          instancesById,
          usersById,
        })
      )
    },
    // Knowing if a value is a user depends onh the custom_object_field attached to its condition's field
    // For that reason we need to specifically handle it here, using 'is_user_value' field that we added in onFetch
    preDeploy: async (changes: Change<InstanceElement>[]) => {
      const users = await getUsers(paginator)
      const usersByEmail = _.keyBy(users, user => user.email)

      const missingUsers: { path: string[]; condition: CustomObjectCondition}[] = []
      getUserConditions(changes).forEach(({ path, condition }) => {
        if (_.isString(condition.value) && usersByEmail[condition.value]) {
          const userId = usersByEmail[condition.value].id.toString()
          userPathToOriginalValue[path.join(ElemID.NAMESPACE_SEPARATOR)] = condition.value
          condition.value = userId
        } else {
          missingUsers.push({ path, condition })
        }
      })

      const { defaultMissingUserFallback } = config[DEPLOY_CONFIG] ?? {}
      if (missingUsers.length > 0 && defaultMissingUserFallback !== undefined) {
        const userEmails = new Set(users.map(user => user.email))
        const fallbackValue = await getUserFallbackValue(
          defaultMissingUserFallback,
          userEmails,
          client
        )
        if (fallbackValue !== undefined) {
          missingUsers.forEach(({ condition }) => {
            condition.value = fallbackValue
          })
        } else {
          log.error('Error while trying to get defaultMissingUserFallback value in customObjectFieldsFilter')
        }
      }
    },
    onDeploy: async (changes: Change<InstanceElement>[]) => {
      getUserConditions(changes).forEach(({ path, condition }) => {
        condition.value = userPathToOriginalValue[path.join(ElemID.NAMESPACE_SEPARATOR)]
          ? userPathToOriginalValue[path.join(ElemID.NAMESPACE_SEPARATOR)]
          : condition.value
      })
    },
  }
}

export default customObjectFieldsFilter
