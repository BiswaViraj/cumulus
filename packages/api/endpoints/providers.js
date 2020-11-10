'use strict';

const router = require('express-promise-router')();

const omit = require('lodash/omit');

const {
  getKnexClient,
  tableNames,
  rdsProviderFromCumulusProvider,
  validateProviderHost,
} = require('@cumulus/db');
const { inTestMode } = require('@cumulus/common/test-utils');
const { RecordDoesNotExist } = require('@cumulus/errors');
const Logger = require('@cumulus/logger');
const Provider = require('../models/providers');
const { AssociatedRulesError, isBadRequestError } = require('../lib/errors');
const { Search } = require('../es/search');
const { addToLocalES, indexProvider } = require('../es/indexer');

const log = new Logger({ sender: '@cumulus/api/providers' });

/**
 * List all providers
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function list(req, res) {
  const search = new Search(
    { queryStringParameters: req.query },
    'provider',
    process.env.ES_INDEX
  );

  const response = await search.query();
  return res.send(response);
}

/**
 * Query a single provider
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function get(req, res) {
  const id = req.params.id;

  const providerModel = new Provider();
  let result;
  try {
    result = await providerModel.get({ id });
  } catch (error) {
    if (error instanceof RecordDoesNotExist) return res.boom.notFound('Provider not found.');
  }
  delete result.password;
  return res.send(result);
}

async function providerExistsInPostgres(knex, name) {
  const queryResult = await knex(tableNames.providers).select().where({ name });
  return (queryResult.length !== 0);
}

class ApiProviderCollisionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CumulusMessageError';
    Error.captureStackTrace(this, ApiProviderCollisionError);
  }
}

async function throwIfDynamoRecordExists(providerModel, id) {
  try {
    await providerModel.get({ id });
    throw new ApiProviderCollisionError(`Dynamo record id ${id} exists`);
  } catch (error) {
    if (!(error instanceof RecordDoesNotExist)) {
      throw error;
    }
  }
}

/**
 * Creates a new provider
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function post(req, res) {
  const data = req.body;
  const id = data.id;

  const providerModel = new Provider();
  const knex = await getKnexClient({ env: process.env });
  try {
    let record;
    await throwIfDynamoRecordExists(providerModel, id);
    await knex.transaction(async (trx) => {
      const createObject = await rdsProviderFromCumulusProvider(data);
      validateProviderHost(createObject.host);
      await trx(tableNames.providers).insert(createObject);
      record = await providerModel.create(data);
      if (inTestMode()) {
        await addToLocalES(record, indexProvider);
      }
    });
    return res.send({ record, message: 'Record saved' });
  } catch (error) {
    if (error instanceof ApiProviderCollisionError || error.code === '23505') {
      // Postgres error codes:
      // https://www.postgresql.org/docs/9.2/errcodes-appendix.html
      return res.boom.conflict(`A record already exists for ${id}`);
    }
    // TODO - What should we do about db schema validation?   Knex casts
    // everything.
    if (isBadRequestError(error)) { // TODO - should we have a knex schema failure error?
      return res.boom.badRequest(error.message);
    }
    log.error('Error occurred while trying to create provider:', error);
    return res.boom.badImplementation(error.message);
  }
}

function nullifyUndefinedValues(data) {
  const returnData = { ...data };
  const optionalValues = ['port', 'username', 'password', 'globalConnectionLimit', 'privateKey', 'cmKeyId', 'certificateUri'];
  optionalValues.forEach((value) => {
    // eslint-disable-next-line unicorn/no-null
    returnData[value] = returnData[value] ? returnData[value] : null;
  });
  return returnData;
}

/**
 * Updates an existing provider
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function put({ params: { id }, body }, res) {
  if (id !== body.id) {
    return res.boom.badRequest(
      `Expected provider ID to be '${id}', but found '${body.id}' in payload`
    );
  }

  const knex = await getKnexClient({ env: process.env });
  const providerModel = new Provider();

  const providerExists = await Promise.all([
    providerModel.exists(id),
    providerExistsInPostgres(knex, id),
  ]);

  if (providerExists.filter(Boolean).length !== 2) {
    return res.boom.notFound(
      `Provider with ID '${id}' not found in Dynamo and PostGres databases`
    );
  }
  // trx create db record with knex
  let record;
  // TODO *gah, we need to 'blank' any fields that are non-existant
  await knex.transaction(async (trx) => {
    let createObject = { // TODO - make this a seperate method
      ...(omit(body, ['id', 'encrypted', 'createdAt', 'updatedAt'])),
      name: body.id,
      created_at: body.createdAt,
      updated_at: body.updatedAt,
    };
    createObject = nullifyUndefinedValues(createObject);
    await trx(tableNames.providers).where({ name: id }).update(createObject);
    record = await providerModel.create(body);
  });
  return res.send(record);
}

/**
 * Delete a provider
 *
 * @param {Object} req - express request object
 * @param {Object} res - express response object
 * @returns {Promise<Object>} the promise of express response object
 */
async function del(req, res) {
  const providerModel = new Provider();
  const knex = await getKnexClient({ env: process.env });

  try {
    await knex.transaction(async (trx) => {
      await trx(tableNames.providers).where({ name: req.params.id }).del();
      await providerModel.delete({ id: req.params.id });
      if (inTestMode()) {
        const esClient = await Search.es(process.env.ES_HOST);
        await esClient.delete({
          id: req.params.id,
          type: 'provider',
          index: process.env.ES_INDEX,
        }, { ignore: [404] });
      }
    });
    return res.send({ message: 'Record deleted' });
  } catch (error) {
    if (error instanceof AssociatedRulesError || error.constraint === 'rules_providercumulusid_foreign') {
      const messageDetail = error.rules || [error.detail];
      console.log(process.env.PG_DATABASE);
      const message = `Cannot delete provider with associated rules: ${messageDetail.join(', ')}`;
      return res.boom.conflict(message);
    }
    throw error;
  }
}

// express routes
router.get('/:id', get);
router.put('/:id', put);
router.delete('/:id', del);
router.post('/', post);
router.get('/', list);

module.exports = router;
