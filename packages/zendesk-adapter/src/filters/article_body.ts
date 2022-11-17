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
import { logger } from '@salto-io/logging'
import {
  Change, getChangeData, InstanceElement, isAdditionOrModificationChange, isInstanceChange,
  isInstanceElement, ReferenceExpression, TemplateExpression, TemplatePart,
} from '@salto-io/adapter-api'
import { applyFunctionToChangeData, extractTemplate, replaceTemplatesWithValues, resolveTemplates, safeJsonStringify } from '@salto-io/adapter-utils'
import { collections } from '@salto-io/lowerdash'
import { FilterCreator } from '../filter'
import { ARTICLE_TRANSLATION_TYPE_NAME, ARTICLE_TYPE_NAME, BRAND_TYPE_NAME } from '../constants'

const log = logger(module)
const { awu } = collections.asynciterable

const BODY_FIELD = 'body'

const BASE_URL_REGEX = /(https:\/\/[^/]+)/
const ARTICLE_ID_URL_REGEX = /(\/articles\/\d*)/

const ARTICLE_ID_REGEX = /(?<articleUrl>\/articles\/)(?<articleId>\d*)/

const referenceUrls = ({
  urlPart,
  brandInstances,
  articleInstances,
}: {
  urlPart: string
  brandInstances: InstanceElement[]
  articleInstances: InstanceElement[]
}): TemplatePart[] => {
  const urlSubdomain = urlPart.match(BASE_URL_REGEX)?.pop()
  const urlBrand = brandInstances
    .find(brandInstance => brandInstance.value.brand_url === urlSubdomain)
  if (isInstanceElement(urlBrand)) {
    return [new ReferenceExpression(urlBrand.elemID.createNestedID('brand_url'), urlBrand?.value.brand_url)]
  }

  const { articleUrl, articleId } = urlPart.match(ARTICLE_ID_REGEX)?.groups ?? {}
  if (articleUrl && articleId) {
    const referencedArticle = articleInstances
      .find(articleInstance => articleInstance.value.id.toString() === articleId)
    if (isInstanceElement(referencedArticle)) {
      return [
        articleUrl,
        new ReferenceExpression(referencedArticle.elemID, referencedArticle),
      ]
    }
  }
  return [urlPart]
}

const updateArticleBody = (
  articleInstace: InstanceElement,
  brandInstances: InstanceElement[],
  articleInstances: InstanceElement[],
): void => {
  const originalArticleBody = articleInstace.value[BODY_FIELD]
  if (!_.isString(originalArticleBody)) {
    return
  }
  const processedArticleBody = extractTemplate(
    originalArticleBody,
    [BASE_URL_REGEX, ARTICLE_ID_URL_REGEX],
    articleUrl => referenceUrls({ url: articleUrl, brandInstances, articleInstances }),
  )
  articleInstace.value.body = processedArticleBody
}

/**
 * Process template Expression references by the id type
 */
export const prepRef = (part: ReferenceExpression): TemplatePart => {
  if (part.elemID.isTopLevel()) {
    return part.value.value.id.toString()
  }
  if (!_.isString(part.value)) {
    throw new Error(`Received an invalid value inside a template expression ${part.elemID.getFullName()}: ${safeJsonStringify(part.value)}`)
  }
  return part.value
}

/**
 * Process body value in article instances to reference other objects
 */
const filterCreator: FilterCreator = () => {
  const deployTemplateMapping: Record<string, TemplateExpression> = {}
  return {
    onFetch: async elements => {
      const instances = elements.filter(isInstanceElement)
      const brandInstances = instances
        .filter(e => e.elemID.typeName === BRAND_TYPE_NAME)
      const articleInstances = instances
        .filter(e => e.elemID.typeName === ARTICLE_TYPE_NAME)
      instances
        .filter(instance => instance.elemID.typeName === ARTICLE_TRANSLATION_TYPE_NAME)
        .filter(articleInstance => !_.isEmpty(articleInstance.value[BODY_FIELD]))
        .forEach(articleInstance => (
          updateArticleBody(articleInstance, brandInstances, articleInstances)))
    },
    preDeploy: async (changes: Change<InstanceElement>[]) => {
      await awu(changes)
        .filter(isAdditionOrModificationChange)
        .filter(isInstanceChange)
        .filter(change => getChangeData(change).elemID.typeName === ARTICLE_TRANSLATION_TYPE_NAME)
        .forEach(async change => {
          await applyFunctionToChangeData<Change<InstanceElement>>(
            change,
            instance => {
              try {
                replaceTemplatesWithValues(
                  { values: [instance.value], fieldName: 'body' },
                  deployTemplateMapping,
                  prepRef,
                )
              } catch (e) {
                log.error('Error parsing article body value in deployment', e)
              }
              return instance
            }
          )
        })
    },

    onDeploy: async (changes: Change<InstanceElement>[]) => {
      await awu(changes)
        .filter(isAdditionOrModificationChange)
        .filter(isInstanceChange)
        .filter(change => getChangeData(change).elemID.typeName === ARTICLE_TRANSLATION_TYPE_NAME)
        .forEach(async change => {
          await applyFunctionToChangeData<Change<InstanceElement>>(
            change,
            instance => {
              resolveTemplates(
                { values: [instance.value], fieldName: 'body' },
                deployTemplateMapping,
              )
              return instance
            }
          )
        })
    },
  }
}

export default filterCreator
