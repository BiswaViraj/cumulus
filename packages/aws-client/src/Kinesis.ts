/**
 * Utility functions for interacting with Kinesis
 *
 * @module Kinesis
 *
 * @example
 * const Kinesis = require('@cumulus/aws-client/Kinesis');
 */

import pRetry = require('p-retry');
import { kinesis } from './services';

/**
 * Describe a Kinesis stream.
 *
 * @param {Object} params
 * @param {string} params.StreamName - A Kinesis stream name
 * @param {Object} retryOptions - Options passed to p-retry module
 * @returns {Promise<Object>} - The stream description response
 *
 * @alias module:Kinesis
 */
const describeStream = (params: AWS.Kinesis.DescribeStreamInput, retryOptions: pRetry.Options = { retries: 0 }) =>
  pRetry(
    async () => {
      try {
        return await kinesis().describeStream(params).promise();
      } catch (err) {
        if (err.code === 'ResourceNotFoundException') throw err;
        throw new pRetry.AbortError(err);
      }
    },
    { maxTimeout: 10000, ...retryOptions }
  );

export = describeStream;
