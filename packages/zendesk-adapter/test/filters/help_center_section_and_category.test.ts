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

import { client as clientUtils, filterUtils, elements as elementUtils } from '@salto-io/adapter-components'
import {
  ElemID,
  InstanceElement,
  ObjectType, ReferenceExpression,
  toChange,
} from '@salto-io/adapter-api'
import ZendeskClient from '../../src/client/client'
import filterCreator from '../../src/filters/help_center_section_and_category'
import { paginate } from '../../src/client/pagination'
import { DEFAULT_CONFIG } from '../../src/config'
import { ZENDESK } from '../../src/constants'

describe('guid section filter', () => {
  let client: ZendeskClient
  type FilterType = filterUtils.FilterWith<'onFetch' | 'preDeploy' | 'onDeploy'>
  let filter: FilterType

  const sectionTypeName = 'section'
  const sectionTranslationTypename = 'section_translation'
  const sectionType = new ObjectType({ elemID: new ElemID(ZENDESK, sectionTypeName) })
  const helpCenterLocaleTypename = 'help_center_locale'
  const sectionTranslationType = new ObjectType(
    { elemID: new ElemID(ZENDESK, sectionTranslationTypename) }
  )
  const helpCenterLocaleType = new ObjectType(
    { elemID: new ElemID(ZENDESK, helpCenterLocaleTypename) }
  )

  const helpCenterLocaleInstance = new InstanceElement(
    'instance',
    helpCenterLocaleType,
    {
      id: 'he',
    }
  )

  const sectionTranslationInstance = new InstanceElement(
    'instance',
    sectionTranslationType,
    {
      locale: new ReferenceExpression(helpCenterLocaleInstance.elemID, helpCenterLocaleInstance),
      title: 'name',
      body: 'description',
    }
  )

  const sectionInstance = new InstanceElement(
    'instance',
    sectionType,
    {
      source_locale: 'he',
      translations: [
        sectionTranslationInstance.value,
      ],
    }
  )


  beforeEach(async () => {
    client = new ZendeskClient({
      credentials: { username: 'a', password: 'b', subdomain: 'ignore' },
    })
    filter = filterCreator({
      client,
      paginator: clientUtils.createPaginator({
        client,
        paginationFuncCreator: paginate,
      }),
      config: DEFAULT_CONFIG,
      fetchQuery: elementUtils.query.createMockQuery(),
    }) as FilterType
  })

  describe('preDeploy', () => {
    it('should add the name and description fields before deploy', async () => {
      const sectionInstanceCopy = sectionInstance.clone()
      await filter.preDeploy([toChange({ after: sectionInstanceCopy })])
      sectionInstance.value.name = sectionTranslationInstance.value.title
      sectionInstance.value.description = sectionTranslationInstance.value.body
      expect(sectionInstanceCopy).toEqual(sectionInstance)
    })
  })

  describe('onDeploy', () => {
    it('should omit the name and description fields after deploy', async () => {
      const sectionInstanceCopy = sectionInstance.clone()
      await filter.preDeploy([toChange({ after: sectionInstanceCopy })])
      await filter.onDeploy([toChange({ after: sectionInstanceCopy })])
      expect(sectionInstanceCopy.value).toEqual({
        source_locale: 'he',
        translations: [
          sectionTranslationInstance.value,
        ],
      })
    })
  })
})
