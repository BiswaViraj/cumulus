import got from 'got';
import getUrl from './getUrl';
import ValidationError from './ValidationError';
import { ParsedCmrXmlResponse } from './types';

export interface UmmMetadata {
  MetadataSpecification: {
    Version?: string
  }
}

/**
 * Find the UMM version as a decimal string.
 * If a version cannot be found on the input object
 * version 1.4 is assumed and returned.
 *
 * @param {UmmMetadata} umm - UMM metadata object
 * @returns {string} UMM version for the given object
 */
export const ummVersion = (umm: UmmMetadata): string =>
  umm.MetadataSpecification?.Version ?? '1.4';

/**
 * Posts a given XML string to the validate endpoint of CMR and throws an
 * exception if it is not valid
 *
 * @param {UmmMetadata} ummMetadata - the UMM object
 * @param {string} identifier - the document identifier
 * @param {string} provider - the CMR provider
 * @returns {Promise<undefined>}
 */
export const validateUMMG = async (
  ummMetadata: UmmMetadata,
  identifier: string,
  provider: string
): Promise<void> => {
  const version = ummVersion(ummMetadata);

  const { statusCode, body } = await got.post(
    `${getUrl('validate', provider)}granule/${identifier}`,
    {
      headers: {
        Accept: 'application/json',
        'Content-type': `application/vnd.nasa.cmr.umm+json;version=${version}`
      },
      json: ummMetadata,
      responseType: 'json',
      throwHttpErrors: false
    }
  );

  if (statusCode === 200) return;

  const errors = JSON.stringify((<ParsedCmrXmlResponse>body).errors);

  throw new ValidationError(
    `Validation was not successful, CMR error message: ${errors}`
  );
};
