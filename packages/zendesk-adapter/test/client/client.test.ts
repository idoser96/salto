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
import axios from 'axios'
import MockAdapter from 'axios-mock-adapter'
import ZendeskClient from '../../src/client/client'

describe('client', () => {
  describe('getSinglePage', () => {
    let mockAxios: MockAdapter
    let client: ZendeskClient
    beforeEach(() => {
      mockAxios = new MockAdapter(axios)
      client = new ZendeskClient({
        credentials: { username: 'a', password: 'b', subdomain: 'ignore' },
        config: { retry: { retryDelay: 0 } },
      })
    })

    afterEach(() => {
      mockAxios.restore()
    })

    it('should return an empty result when there is a 404 response', async () => {
      // The first replyOnce with 200 is for the client authentication
      mockAxios.onGet().replyOnce(200).onGet().replyOnce(404)
      const res = await client.getSinglePage({ url: '/api/v2/routing/attributes' })
      expect(res.data).toEqual([])
      expect(res.status).toEqual(404)
    })
    it('should throw when there is a 403 response', async () => {
      // The first replyOnce with 200 is for the client authentication
      mockAxios.onGet().replyOnce(200).onGet().replyOnce(403)
      await expect(client.getSinglePage({ url: '/api/v2/routing/attributes' })).rejects.toThrow()
    })
    it('should throw if there is no status in the error', async () => {
      // The first replyOnce with 200 is for the client authentication
      mockAxios.onGet().replyOnce(200).onGet().replyOnce(() => { throw new Error('Err') })
      await expect(
        client.getSinglePage({ url: '/api/v2/routing/attributes' })
      ).rejects.toThrow()
    })
    it('should retry on 409, 429 and 503', async () => {
      // The first replyOnce with 200 is for the client authentication
      mockAxios.onGet().replyOnce(200)
        .onPost()
        .replyOnce(429)
        .onPost()
        .replyOnce(409)
        .onPost()
        .replyOnce(503)
        .onPost()
        .replyOnce(200)
      await client.post({ url: '/api/v2/routing/attributes', data: {} })
      expect(mockAxios.history.post.length).toEqual(4)
    })

    it('should filter out responses data by config', async () => {
      const orgsResponse = { organizations: [{ id: 1, name: 'org1' }, { id: 2, name: 'org2' }] }
      const filteredOrgsResponse = { organizations: [{ id: 1, name: '***' }, { id: 2, name: '***' }] }
      mockAxios.onGet().replyOnce(200).onGet().reply(() => [200, orgsResponse])
      const notFilteringClient = new ZendeskClient(
        { credentials: { username: 'a', password: 'b', subdomain: 'ignore' }, allowOrganizationNames: true }
      )
      const notFilteredResults = [
        await notFilteringClient.getSinglePage({ url: 'organizations/show_many' }),
        await notFilteringClient.getSinglePage({ url: 'organizations/autocomplete' }),
      ]
      const filteredResults = [
        await client.getSinglePage({ url: 'organizations/show_many' }),
        await client.getSinglePage({ url: 'organizations/autocomplete' }),
      ]

      expect(notFilteredResults.map(res => res.data)).toMatchObject([orgsResponse, orgsResponse])
      expect(filteredResults.map(res => res.data)).toMatchObject([filteredOrgsResponse, filteredOrgsResponse])
    })
  })
})
