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
import { ElemID } from './element_id'

export type SeverityLevel = 'Error' | 'Warning' | 'Info'

export type SaltoErrorSource = 'config'

export type SaltoError = {
    message: string
    severity: SeverityLevel
    source?: SaltoErrorSource
}

export type SaltoElementError = SaltoError & {
    elemID: ElemID
}

export const isSaltoElementError = (error: SaltoError | SaltoElementError):
    error is SaltoElementError => 'elemID' in error

export class CredentialError extends Error {}

export const isCredentialError = (error: unknown): error is CredentialError =>
  error instanceof CredentialError
