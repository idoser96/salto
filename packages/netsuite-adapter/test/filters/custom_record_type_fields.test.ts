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
import { BuiltinTypes, ElemID, ObjectType } from '@salto-io/adapter-api'
import { CUSTOM_RECORD_TYPE, METADATA_TYPE, NETSUITE, SCRIPT_ID } from '../../src/constants'
import filterCreator from '../../src/filters/custom_record_type_fields'

describe('custom record type fields filter', () => {
  let customRecordType: ObjectType
  beforeEach(async () => {
    customRecordType = new ObjectType({
      elemID: new ElemID(NETSUITE, 'customrecord1'),
      annotations: {
        [METADATA_TYPE]: CUSTOM_RECORD_TYPE,
        customrecordcustomfields: {
          customrecordcustomfield: [{
            scriptid: 'custrecord_newfield',
            fieldtype: 'TEXT',
          }, {
            scriptid: 'custrecord_ref',
            fieldtype: 'SELECT',
            selectrecordtype: `[${SCRIPT_ID}=customrecord1]`,
          }],
        },
      },
    })
  })
  it('should add fields to type', async () => {
    await filterCreator().onFetch([customRecordType])
    expect(Object.keys(customRecordType.fields)).toEqual(['custom_custrecord_newfield', 'custom_custrecord_ref'])
    expect(customRecordType.fields.custom_custrecord_newfield.refType.elemID.name)
      .toEqual(BuiltinTypes.STRING.elemID.name)
    expect(customRecordType.fields.custom_custrecord_newfield.annotations).toEqual({
      scriptid: 'custrecord_newfield',
      fieldtype: 'TEXT',
      index: 0,
    })
    expect(customRecordType.fields.custom_custrecord_ref.refType.elemID.name)
      .toEqual('customrecord1')
    expect(customRecordType.fields.custom_custrecord_ref.annotations).toEqual({
      scriptid: 'custrecord_ref',
      fieldtype: 'SELECT',
      selectrecordtype: `[${SCRIPT_ID}=customrecord1]`,
      index: 1,
    })
  })
  it('should remove custom fields annotation', async () => {
    await filterCreator().onFetch([customRecordType])
    expect(customRecordType.annotations.customrecordcustomfields).toBeUndefined()
  })
})
