/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import type { Model } from '@/types'
import { vendorSupportsImages } from '@shared/defaults/models'

/**
 * Whether image input can be sent for this model.
 *
 * Two independent signals, because they answer for different populations:
 *
 * - `vendor` covers the models we host and therefore know
 *   ({@link vendorSupportsImages}). It refuses to guess, so anything it does not
 *   recognise — every self-hosted gateway model, which the backend publishes
 *   with `vendor: null` — reads as text-only.
 * - The deployment's `visionModels` list covers exactly that gap. An
 *   OpenAI-compatible `/models` response carries no modality information, so the
 *   operator declares it via `THUNDERBOLT_INFERENCE_VISION_MODELS` and it
 *   arrives on `/config`.
 *
 * Either one is sufficient. Getting this wrong is quiet in one direction and
 * loud in the other: too strict and Pi's descriptor advertises text-only and
 * strips image blocks before the wire, so the model receives just the
 * `[Attachment: …]` label and appears to ignore the picture.
 */
export const modelSupportsImages = (
  model: Pick<Model, 'model' | 'vendor'>,
  visionModels: readonly string[] = useConfigStore.getState().config.visionModels ?? [],
): boolean => vendorSupportsImages(model.vendor) || visionModels.includes(model.model)
