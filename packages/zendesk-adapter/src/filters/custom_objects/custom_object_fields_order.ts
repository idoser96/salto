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
  ObjectType, ReferenceExpression,
} from '@salto-io/adapter-api'
import _ from 'lodash'
import { getParent, getParents, inspectValue } from '@salto-io/adapter-utils'
import { FilterCreator } from '../../filter'
import {
  CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME,
  CUSTOM_OBJECT_FIELD_TYPE_NAME,
  CUSTOM_OBJECT_TYPE_NAME,
  ZENDESK,
} from '../../constants'

const ORDER_FIELD = `${CUSTOM_OBJECT_FIELD_TYPE_NAME}s`

const customObjectFieldsOrderType = new ObjectType({
  elemID: new ElemID(ZENDESK, CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME),
  fields: {
    [ORDER_FIELD]: { refType: new ListType(BuiltinTypes.NUMBER) },
  },

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
    Object.entries(customObjectFieldsByParentName).forEach(([parentName, fields]) => {
      const parent = customObjectsByFullName[parentName]
      const orderInstance = new InstanceElement(
        `${parentName}_order`,
        customObjectFieldsOrderType,
        {
          [ORDER_FIELD]: fields.map(field => field.value.id),
        },
        undefined,
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
    const deployResultsPromises = changes
      .filter(isInstanceChange)
      .filter(isAdditionOrModificationChange)
      .map(getChangeData)
      .filter(instance => instance.elemID.typeName === CUSTOM_OBJECT_FIELD_ORDER_TYPE_NAME)
      .map(async customObjectFieldOrder => {
        const parentKey = getParent(customObjectFieldOrder).value.key
        if (parentKey === undefined) {
          return 'parent key is undefined'
        }
        const result = await client.put({
          url: `/api/v2/custom_objects/${parentKey}/fields`,
          data: {
            ids: customObjectFieldOrder.value[ORDER_FIELD],
          },
        })
        return result.status === 200
          ? undefined
          : `reorder request failed, ${inspectValue(result.data)}`
      })

    const deployResult = await Promise.all(deployResultsPromises)
  },
})

export default customObjectFieldsOrderFilter
