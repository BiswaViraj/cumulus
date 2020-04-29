/**
 * @module S3
 */

import fs = require('fs');
import path = require('path');
import pMap = require('p-map');
import pRetry = require('p-retry');
import pump = require('pump');
import url = require('url');
import { Readable, TransformOptions } from 'stream';

import {
  generateChecksumFromStream,
  validateChecksumFromStream
} from '@cumulus/checksum';
import {
  InvalidChecksum,
  UnparsableFileLocationError
} from '@cumulus/errors';
import Logger from '@cumulus/json-logger';

import { s3 } from './services';
import { inTestMode } from './test-utils';
import { improveStackTrace } from './utils';

const log = new Logger({
  defaultFields: { sender: 'aws-client/s3' }
});

const S3_RATE_LIMIT = inTestMode() ? 1 : 20;

/**
 * Join strings into an S3 key without a leading slash or double slashes
 *
 * @param {...string|Array<string>} args - the strings to join
 * @returns {string} the full S3 key
 *
 * @static
 */
export function s3Join(...args: [string | string[], ...string[]]) {
  let tokens: string[];
  if (typeof args[0] === 'string') tokens = <string[]>args;
  else tokens = args[0];

  const removeLeadingSlash = (token: string) => token.replace(/^\//, '');
  const removeTrailingSlash = (token: string) => token.replace(/\/$/, '');
  const isNotEmptyString = (token: string) => token.length > 0;

  const key = tokens
    .map(removeLeadingSlash)
    .map(removeTrailingSlash)
    .filter(isNotEmptyString)
    .join('/');

  if (tokens[tokens.length - 1].endsWith('/')) return `${key}/`;
  return key;
}

/**
* parse an s3 uri to get the bucket and key
*
* @param {string} uri - must be a uri with the `s3://` protocol
* @returns {Object} Returns an object with `Bucket` and `Key` properties
**/
export const parseS3Uri = (uri: string) => {
  const parsedUri = url.parse(uri);

  if (parsedUri.protocol !== 's3:') {
    throw new TypeError('uri must be a S3 uri, e.g. s3://bucketname');
  }

  if (parsedUri.path === null) {
    throw new TypeError(`Unable to determine key of ${uri}`);
  }

  return {
    Bucket: parsedUri.hostname,
    Key: parsedUri.path.substring(1)
  };
};

/**
 * Given a bucket and key, return an S3 URI
 *
 * @param {string} bucket - an S3 bucket name
 * @param {string} key - an S3 key
 * @returns {string} an S3 URI
 */
export const buildS3Uri = (bucket: string, key: string) =>
  `s3://${bucket}/${key.replace(/^\/+/, '')}`;


/**
* Convert S3 TagSet Object to query string
* e.g. [{ Key: 'tag', Value: 'value }] to 'tag=value'
*
* @param {Array<Object>} tagset - S3 TagSet array
* @returns {string} tags query string
*/
export const s3TagSetToQueryString = (tagset: AWS.S3.TagSet) =>
  tagset.reduce((acc, tag) => acc.concat(`&${tag.Key}=${tag.Value}`), '').substring(1);

/**
 * Delete an object from S3
 *
 * @param {string} bucket - bucket where the object exists
 * @param {string} key - key of the object to be deleted
 * promise of the object being deleted
 */
export const deleteS3Object = improveStackTrace(
  (bucket: string, key: string) =>
    s3().deleteObject({ Bucket: bucket, Key: key }).promise()
);

/**
* Get an object header from S3
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} retryOptions - options to control retry behavior when an
*   object does not exist. See https://github.com/tim-kos/node-retry#retryoperationoptions
*   By default, retries will not be performed
* @returns {Promise} returns response from `S3.headObject` as a promise
**/
export const headObject = improveStackTrace(
  (Bucket: string, Key: string, retryOptions: pRetry.Options = { retries: 0 }) =>
    pRetry(
      async () => {
        try {
          return await s3().headObject({ Bucket, Key }).promise();
        } catch (err) {
          if (err.code === 'NotFound') throw err;
          throw new pRetry.AbortError(err);
        }
      },
      { maxTimeout: 10000, ...retryOptions }
    )
);

/**
 * Test if an object exists in S3
 *
 * @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#headObject-property
 * @returns {Promise<boolean>} a Promise that will resolve to a boolean indicating
 *                               if the object exists
 */
export const s3ObjectExists = (params: { Bucket: string, Key: string }) =>
  headObject(params.Bucket, params.Key)
    .then(() => true)
    .catch((e) => {
      if (e.code === 'NotFound') return false;
      throw e;
    });

/**
* Put an object on S3
*
* @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
* promise of the object being put
**/
export const s3PutObject = improveStackTrace(
  (params: AWS.S3.PutObjectRequest) => s3().putObject({
    ACL: 'private',
    ...params
  }).promise()
);

/**
 * Upload a file to S3
 *
 * @param {string} bucket - the destination S3 bucket
 * @param {string} key - the destination S3 key
 * @param {filename} filename - the local file to be uploaded
 * @returns {Promise}
 */
export const putFile = (bucket: string, key: string, filename: string) =>
  s3PutObject({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filename)
  });

/**
* Copy an object from one location on S3 to another
*
* @param {Object} params - same params as https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObject-property
* @returns {Promise} promise of the object being copied
**/
export const s3CopyObject = improveStackTrace(
  (params: AWS.S3.CopyObjectRequest) => s3().copyObject({
    TaggingDirective: 'COPY',
    ...params
  }).promise()
);

/**
 * Upload data to S3
 *
 * Note: This is equivalent to calling `aws.s3().upload(params).promise()`
 *
 * @param {Object} params - see [S3.upload()](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property)
 * @returns {Promise} see [S3.upload()](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#upload-property)
 */
export const promiseS3Upload = improveStackTrace(
  (params: AWS.S3.PutObjectRequest) => s3().upload(params).promise()
);

/**
 * Downloads the given s3Obj to the given filename in a streaming manner
 *
 * @param {Object} s3Obj - The parameters to send to S3 getObject call
 * @param {string} filepath - The filepath of the file that is downloaded
 * @returns {Promise<string>} returns filename if successful
 */
export const downloadS3File = (s3Obj: AWS.S3.GetObjectRequest, filepath: string) => {
  const fileWriteStream = fs.createWriteStream(filepath);

  return new Promise((resolve, reject) => {
    const objectReadStream = s3().getObject(s3Obj).createReadStream();

    pump(objectReadStream, fileWriteStream, (err) => {
      if (err) reject(err);
      else resolve(filepath);
    });
  });
};

/**
 * Get the size of an S3Object, in bytes
 *
 * @param {string} bucket - S3 bucket
 * @param {string} key - S3 key
 * @returns {Promise<integer>} object size, in bytes
 */
export const getObjectSize = (bucket: string, key: string) =>
  headObject(bucket, key, { retries: 3 })
    .then((response) => response.ContentLength);

/**
* Get object Tagging from S3
*
* @param {string} bucket - name of bucket
* @param {string} key - key for object (filepath + filename)
* @returns {Promise} returns response from `S3.getObjectTagging` as a promise
**/
export const s3GetObjectTagging = improveStackTrace(
  (bucket: string, key: string) =>
    s3().getObjectTagging({ Bucket: bucket, Key: key }).promise()
);

/**
* Puts object Tagging in S3
* https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#putObjectTagging-property
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} Tagging - tagging object
* @returns {Promise} returns response from `S3.getObjectTagging` as a promise
**/
export const s3PutObjectTagging = improveStackTrace(
  (Bucket: string, Key: string, Tagging: AWS.S3.Tagging) =>
    s3().putObjectTagging({
      Bucket,
      Key,
      Tagging
    }).promise()
);

/**
* Get an object from S3
*
* @param {string} Bucket - name of bucket
* @param {string} Key - key for object (filepath + filename)
* @param {Object} retryOptions - options to control retry behavior when an
*   object does not exist. See https://github.com/tim-kos/node-retry#retryoperationoptions
*   By default, retries will not be performed
* @returns {Promise} returns response from `S3.getObject` as a promise
**/
export const getS3Object = improveStackTrace(
  (Bucket: string, Key: string, retryOptions: pRetry.Options = { retries: 0 }) =>
    pRetry(
      async () => {
        try {
          return await s3().getObject({ Bucket, Key }).promise();
        } catch (err) {
          if (err.code === 'NoSuchKey') throw err;
          throw new pRetry.AbortError(err);
        }
      },
      {
        maxTimeout: 10000,
        onFailedAttempt: (err) => log.debug(`getS3Object('${Bucket}', '${Key}') failed with ${err.retriesLeft} retries left: ${err.message}`),
        ...retryOptions
      }
    )
);

/**
 * Fetch the contents of an S3 object
 *
 * @param {string} bucket - the S3 object's bucket
 * @param {string} key - the S3 object's key
 * @returns {Promise<string>} the contents of the S3 object
 */
export const getTextObject = (bucket: string, key: string) =>
  getS3Object(bucket, key)
    .then(({ Body }) => {
      if (Body === undefined) return undefined;
      return Body.toString();
    });

/**
 * Fetch JSON stored in an S3 object
 * @param {string} bucket - the S3 object's bucket
 * @param {string} key - the S3 object's key
 * @returns {Promise<*>} the contents of the S3 object, parsed as JSON
 */
export const getJsonS3Object = (bucket: string, key: string) =>
  getTextObject(bucket, key)
    .then((text) => {
      if (text === undefined) return undefined;
      return JSON.parse(text);
    });

export const putJsonS3Object = (bucket: string, key: string, data: any) =>
  s3PutObject({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data)
  });

/**
 * Get a readable stream for an S3 object.
 *
 * @param {string} bucket - the S3 object's bucket
 * @param {string} key - the S3 object's key
 * @returns {ReadableStream}
 * @throws {Error} if S3 object cannot be found
 */
export const getS3ObjectReadStream = (bucket: string, key: string) =>
  s3().getObject(
    { Bucket: bucket, Key: key }
  ).createReadStream();

/**
 * Get a readable stream for an S3 object.
 *
 * Use `getS3Object()` before fetching stream to deal
 * with eventual consistency issues by checking for object
 * with retries.
 *
 * @param {string} bucket - the S3 object's bucket
 * @param {string} key - the S3 object's key
 * @returns {ReadableStream}
 * @throws {Error} if S3 object cannot be found
 */
export const getS3ObjectReadStreamAsync = (bucket: string, key: string) =>
  getS3Object(bucket, key, { retries: 3 })
    .then(() => getS3ObjectReadStream(bucket, key));

/**
* Check if a file exists in an S3 object
*
* @param {string} bucket - name of the S3 bucket
* @param {string} key - key of the file in the S3 bucket
* @returns {Promise} returns the response from `S3.headObject` as a promise
**/
export const fileExists = async (bucket: string, key: string) => {
  try {
    const r = await s3().headObject({ Key: key, Bucket: bucket }).promise();
    return r;
  } catch (e) {
    // if file is not return false
    if (e.stack.match(/(NotFound)/) || e.stack.match(/(NoSuchBucket)/)) {
      return false;
    }
    throw e;
  }
};

export const downloadS3Files = (
  s3Objs: AWS.S3.GetObjectRequest[],
  dir: string,
  s3opts: Partial<AWS.S3.GetObjectRequest> = {}
) => {
  // Scrub s3Ojbs to avoid errors from the AWS SDK
  const scrubbedS3Objs = s3Objs.map((s3Obj) => ({
    Bucket: s3Obj.Bucket,
    Key: s3Obj.Key
  }));
  let i = 0;
  const n = s3Objs.length;
  log.info(`Starting download of ${n} keys to ${dir}`);
  const promiseDownload = (s3Obj: AWS.S3.GetObjectRequest) => {
    const filename = path.join(dir, path.basename(s3Obj.Key));
    const file = fs.createWriteStream(filename);
    const opts = Object.assign(s3Obj, s3opts);
    return new Promise((resolve, reject) => {
      s3().getObject(opts)
        .createReadStream()
        .pipe(file)
        .on('finish', () => {
          log.info(`Progress: [${i} of ${n}] s3://${s3Obj.Bucket}/${s3Obj.Key} -> ${filename}`);
          i += 1;
          return resolve(s3Obj.Key);
        })
        .on('error', reject);
    });
  };

  return pMap(scrubbedS3Objs, promiseDownload, { concurrency: S3_RATE_LIMIT });
};

/**
 * Delete files from S3
 *
 * @param {Array} s3Objs - An array of objects containing keys 'Bucket' and 'Key'
 * @returns {Promise} A promise that resolves to an Array of the data returned
 *   from the deletion operations
 */
export const deleteS3Files = (s3Objs: AWS.S3.DeleteObjectRequest[]) => pMap(
  s3Objs,
  (s3Obj) => s3().deleteObject(s3Obj).promise(),
  { concurrency: S3_RATE_LIMIT }
);

/**
* Delete a bucket and all of its objects from S3
*
* @param {string} bucket - name of the bucket
* @returns {Promise} the promised result of `S3.deleteBucket`
**/
export const recursivelyDeleteS3Bucket = improveStackTrace(
  async (bucket: string) => {
    const response = await s3().listObjects({ Bucket: bucket }).promise();
    const s3Objects: AWS.S3.DeleteObjectRequest[] = (response.Contents || []).map((o) => {
      if (!o.Key) throw new Error(`Unable to determine S3 key of ${JSON.stringify(o)}`);

      return {
        Bucket: bucket,
        Key: o.Key
      };
    });

    await deleteS3Files(s3Objects);
    await s3().deleteBucket({ Bucket: bucket }).promise();
  }
);

type FileInfo = {
  filename: string,
  key: string,
  bucket: string
};

export const uploadS3Files = (
  files: Array<string|FileInfo>,
  defaultBucket: string,
  keyPath: string | ((x: string) => string),
  s3opts: Partial<AWS.S3.PutObjectRequest> = {}
) => {
  let i = 0;
  const n = files.length;
  if (n > 1) {
    log.info(`Starting upload of ${n} keys`);
  }
  const promiseUpload = async (file: string | FileInfo) => {
    let bucket: string;
    let filename: string;
    let key: string;

    if (typeof file === 'string') {
      bucket = defaultBucket;
      filename = file;

      if (typeof keyPath === 'string') {
        // FIXME Should not be using path.join here, since that could be a backslash
        key = path.join(keyPath, path.basename(file));
      } else {
        key = keyPath(file);
      }
    } else {
      bucket = file.bucket || defaultBucket;
      filename = file.filename;
      key = file.key;
    }

    await promiseS3Upload({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filename),
      ...s3opts
    });

    i += 1;

    log.info(`Progress: [${i} of ${n}] ${filename} -> s3://${bucket}/${key}`);

    return { key, bucket };
  };

  return pMap(files, promiseUpload, { concurrency: S3_RATE_LIMIT });
};

/**
 * Upload the file associated with the given stream to an S3 bucket
 *
 * @param {ReadableStream} fileStream - The stream for the file's contents
 * @param {string} bucket - The S3 bucket to which the file is to be uploaded
 * @param {string} key - The key to the file in the bucket
 * @param {Object} s3opts - Options to pass to the AWS sdk call (defaults to `{}`)
 * @returns {Promise} A promise
 */
export const uploadS3FileStream = (
  fileStream: Readable,
  bucket: string,
  key: string,
  s3opts: Partial<AWS.S3.PutObjectRequest> = {}
) =>
  promiseS3Upload({
    Bucket: bucket,
    Key: key,
    Body: fileStream,
    ...s3opts
  });

/**
 * List the objects in an S3 bucket
 *
 * @param {string} bucket - The name of the bucket
 * @param {string} prefix - Only objects with keys starting with this prefix
 *   will be included (useful for searching folders in buckets, e.g., '/PDR')
 * @param {boolean} skipFolders - If true don't return objects that are folders
 *   (defaults to true)
 * @returns {Promise} A promise that resolves to the list of objects. Each S3
 *   object is represented as a JS object with the following attributes: `Key`,
 * `ETag`, `LastModified`, `Owner`, `Size`, `StorageClass`.
 */
export const listS3Objects = async (
  bucket: string,
  prefix?: string,
  skipFolders: boolean = true
) => {
  log.info(`Listing objects in s3://${bucket}`);
  const params: AWS.S3.ListObjectsRequest = {
    Bucket: bucket
  };
  if (prefix) params.Prefix = prefix;

  const data = await s3().listObjects(params).promise();
  let contents = data.Contents || [];
  if (skipFolders) {
    // Filter out any references to folders
    contents = contents.filter((obj) => obj.Key !== undefined && !obj.Key.endsWith('/'));
  }
  return contents;
};

/**
 * Fetch complete list of S3 objects
 *
 * listObjectsV2 is limited to 1,000 results per call.  This function continues
 * listing objects until there are no more to be fetched.
 *
 * The passed params must be compatible with the listObjectsV2 call.
 *
 * https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjectsV2-property
 *
 * @param {Object} params - params for the s3.listObjectsV2 call
 * @returns {Promise<Array>} resolves to an array of objects corresponding to
 *   the Contents property of the listObjectsV2 response
 *
 * @static
 */
export async function listS3ObjectsV2(params: AWS.S3.ListObjectsV2Request) {
  // Fetch the first list of objects from S3
  let listObjectsResponse = await s3().listObjectsV2(params).promise();
  let discoveredObjects = listObjectsResponse.Contents;

  // Keep listing more objects from S3 until we have all of them
  while (listObjectsResponse.IsTruncated) {
    listObjectsResponse = await s3().listObjectsV2( // eslint-disable-line no-await-in-loop
      // Update the params with a Continuation Token
      {

        ...params,
        ContinuationToken: listObjectsResponse.NextContinuationToken
      }
    ).promise();
    discoveredObjects = (discoveredObjects || []).concat(listObjectsResponse.Contents || []);
  }

  return discoveredObjects;
}

/**
 * Calculate checksum for S3 Object
 *
 * @param {Object} params - params
 * @param {string} params.algorithm - checksum algorithm
 * @param {string} params.bucket - S3 bucket
 * @param {string} params.key - S3 key
 * @param {Object} [params.options] - crypto.createHash options
 *
 * @returns {number|string} calculated checksum
 */
export const calculateS3ObjectChecksum = async (
  params: {
    algorithm: string,
    bucket: string,
    key: string,
    options: TransformOptions
  }
) => {
  const { algorithm, bucket, key, options } = params;
  const fileStream = await getS3ObjectReadStreamAsync(bucket, key);
  return generateChecksumFromStream(algorithm, fileStream, options);
};

/**
 * Validate S3 object checksum against expected sum
 *
 * @param {Object} params - params
 * @param {string} params.algorithm - checksum algorithm
 * @param {string} params.bucket - S3 bucket
 * @param {string} params.key - S3 key
 * @param {number|string} params.expectedSum - expected checksum
 * @param {Object} [params.options] - crypto.createHash options
 *
 * @throws {InvalidChecksum} - Throws error if validation fails
 * @returns {boolean} returns true for success
 */
export const validateS3ObjectChecksum = async (params: {
  algorithm: string,
  bucket: string,
  key: string,
  expectedSum: string,
  options: TransformOptions
}) => {
  const { algorithm, bucket, key, expectedSum, options } = params;
  const fileStream = await getS3ObjectReadStreamAsync(bucket, key);
  if (await validateChecksumFromStream(algorithm, fileStream, expectedSum, options)) {
    return true;
  }
  const msg = `Invalid checksum for S3 object s3://${bucket}/${key} with type ${algorithm} and expected sum ${expectedSum}`;
  throw new InvalidChecksum(msg);
};

/**
 * Extract the S3 bucket and key from the URL path parameters
 *
 * @param {string} pathParams - path parameters from the URL
 * bucket/key in the form of
 * @returns {Array<string>} `[Bucket, Key]`
 */
export const getFileBucketAndKey = (pathParams: string): [string, string] => {
  const [Bucket, ...fields] = pathParams.split('/');

  const Key = fields.join('/');

  if (Bucket.length === 0 || Key.length === 0) {
    throw new UnparsableFileLocationError(`File location "${pathParams}" could not be parsed`);
  }

  return [Bucket, Key];
};

/**
 * Create an S3 bucket
 *
 * @param {string} Bucket - the name of the S3 bucket to create
 * @returns {Promise}
 */
export const createBucket = (Bucket: string) =>
  s3().createBucket({ Bucket }).promise();
