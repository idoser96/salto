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
  ReferenceExpression, Value, TemplateExpression,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { references as referencesUtils, client as clientUtils } from '@salto-io/adapter-components'
import { collections } from '@salto-io/lowerdash'
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
import { FETCH_CONFIG } from '../../config'
import {
  LOOKUP_REGEX,
  RELATIONSHIP_FILTER_REGEX,
  transformCustomObjectLookupField,
  transformFilterField,
  TransformResult,
} from './utils'
import { paginate } from '../../client/pagination'
import { getIdByEmail } from '../../user_utils'

const { makeArray } = collections.array
const { createMissingInstance } = referencesUtils
const { createPaginator } = clientUtils

type CustomObjectCondition = {
  field: string | TemplateExpression
  operator: string
  value?: string | ReferenceExpression
}

const relationTypeToType = (relationshipTargetType: Value): string => {
  if (!_.isString(relationshipTargetType)) {
    return 'unknown'
  }
  // TODO Seroussi - is this possible?
  if (relationshipTargetType.startsWith('zen:custom_object')) {
    return CUSTOM_FIELD_OPTIONS_FIELD_NAME
  }
  switch (relationshipTargetType) {
    case 'zen:user':
      return 'user'
    case 'zen:organization':
      return 'organization'
    case 'zen:ticket':
      return TICKET_FIELD_TYPE_NAME
    default:
      return 'unknown'
  }
}

const isCustomFieldValue = (value: Value): boolean => _.isString(value) && LOOKUP_REGEX.test(value)

type Filter = {
  field: string | TemplateExpression
  operator: string
  value?: string | ReferenceExpression
}

const isRelevantFilter = (filter: Value): filter is Filter =>
  _.isPlainObject(filter) && RELATIONSHIP_FILTER_REGEX.test(filter.field)
  && _.isString(filter.operator)

const isRelevantCondition = (condition: Value): condition is CustomObjectCondition =>
  _.isPlainObject(condition)
  && _.isString(condition.field)
  && _.isString(condition.operator)
  && LOOKUP_REGEX.test(condition.field)

const transformConditionValue = ({
  customObjectField,
  condition,
  enableMissingReferences,
  instancesById,
  usersById,
}: {
  customObjectField?: InstanceElement
  condition: { operator: string; value?: string | ReferenceExpression }
  enableMissingReferences: boolean
  instancesById: Record<string, InstanceElement>
  usersById: Record<string, string>
}): void => {
  if (customObjectField === undefined
    // These are special cases where the value is a reference to an element
    || !['is', 'is_not'].includes(condition.operator)
    || !(_.isString(condition.value) || _.isNumber(condition.value))
    || !['dropdown', 'lookup'].includes(customObjectField.value.type)) {
    return
  }

  // TODO seroussi - it might be possible that we need to check custom object by key
  const referencesElement = instancesById[condition.value] ?? usersById[condition.value]

  if (referencesElement === undefined) {
    if (enableMissingReferences) {
      const missingType = customObjectField.value.type === 'lookup'
        // lookup value type is based on the relationship_target_type of the custom object field
        ? relationTypeToType(customObjectField.value.relationship_target_type)
        : CUSTOM_OBJECT_FIELD_OPTIONS_TYPE_NAME
      const missingCustomOption = createMissingInstance(
        ZENDESK,
        missingType,
        condition.value.toString(),
      )
      condition.value = new ReferenceExpression(missingCustomOption.elemID)
    }
    return
  }

  condition.value = _.isString(referencesElement)
    ? referencesElement // This is a user
    : new ReferenceExpression(referencesElement.elemID, referencesElement) // This is anything else
}

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
  const transformField = (value: string): TransformResult => transformCustomObjectLookupField(
    value,
    instancesById,
    customObjectsByKey,
    enableMissingReferences
  )
  const conditions = (trigger.value.conditions?.all ?? []).concat(trigger.value.conditions?.any ?? [])
  const actions = _.isArray(trigger.value.actions) ? trigger.value.actions : []

  actions
    .filter(action => isCustomFieldValue(makeArray(action.value)[0]))
    .forEach(action => {
      // notification_user is a special case, value is an array and the first element is the custom_object field
      if (action.field === 'notification_user') {
        action.value[0] = transformField(action.value[0]).result
      } else {
        action.value = transformField(action.value).result
      }
    })

  conditions
    .filter(isRelevantCondition)
    .filter((condition: CustomObjectCondition) => isCustomFieldValue(condition.field))
    .forEach((condition: CustomObjectCondition) => {
      // always false, used for type casting
      if (!_.isString(condition.field)) {
        return
      }
      const { result, ticketField, customObjectField } = transformField(condition.field)

      condition.field = result

      if (ticketField !== undefined) {
        transformConditionValue({
          customObjectField,
          condition,
          enableMissingReferences,
          instancesById,
          usersById,
        })
      }
    })
}

const transformRelationshipValue = ({
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
  const relevantRelationshipFilters = (instance.value.relationship_filter?.all ?? [])
    .concat(instance.value.relationship_filter?.any ?? [])
    .filter(isRelevantFilter)

  relevantRelationshipFilters.forEach((filter: Filter) => {
    if (!_.isString(filter.field)) {
      return
    }

    const { result, customObjectField } = transformFilterField(
      filter.field, enableMissingReferences, customObjectsByKey
    )
    filter.field = result

    transformConditionValue({
      customObjectField,
      condition: filter,
      enableMissingReferences,
      instancesById,
      usersById,
    })
  })
}
/**
 *  Convert custom object field values to reference expressions
 */
const customObjectFieldsFilter: FilterCreator = ({ config, client }) => ({
  name: 'customObjectFieldOptionsFilter',
  onFetch: async (elements: Element[]) => {
    const enableMissingReferences = config[FETCH_CONFIG].enableMissingReferences ?? false

    const instances = elements.filter(isInstanceElement)

    const paginator = createPaginator({
      client,
      paginationFuncCreator: paginate,
    })

    // It is possible to key all instance by id because the internal Id is unique across all types (SALTO-4805)
    const usersById = await getIdByEmail(paginator)
    const instancesById = _.keyBy(
      instances.filter(instance => _.isNumber(instance.value.id)),
      instance => _.parseInt(instance.value.id)
    )

    const triggers = instances
      .filter(instance => instance.elemID.typeName === TRIGGER_TYPE_NAME)
    const ticketFields = instances
      .filter(instance => instance.elemID.typeName === TICKET_FIELD_TYPE_NAME)
    const customObjectFields = instances
      .filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_FIELD_TYPE_NAME)

    const customObjectsByKey = _.keyBy(
      instances
        .filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_TYPE_NAME)
        .filter(instance => _.isString(instance.value.key)),
      instance => String(instance.value.key)
    )

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
      instance => transformRelationshipValue({
        instance,
        customObjectsByKey,
        enableMissingReferences,
        instancesById,
        usersById,
      })
    )
  },
})


export default customObjectFieldsFilter
