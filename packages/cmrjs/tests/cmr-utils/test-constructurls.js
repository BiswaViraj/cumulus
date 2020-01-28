const test = require('ava');
const rewire = require('rewire');

const BucketsConfig = require('@cumulus/common/BucketsConfig');
const { randomId } = require('@cumulus/common/test-utils');
const { omit } = require('@cumulus/common/util');

const cmrUtils = rewire('../../cmr-utils');

const constructOnlineAccessUrls = cmrUtils.__get__('constructOnlineAccessUrls');
const constructRelatedUrls = cmrUtils.__get__('constructRelatedUrls');
const getS3CredentialsObject = cmrUtils.__get__('getS3CredentialsObject');
const mapCNMTypeToCMRType = cmrUtils.__get__('mapCNMTypeToCMRType');

const sortByURL = (a, b) => a.URL < b.URL;

const distEndpoint = 'https://endpoint';
const s3CredentialsEndpointObject = getS3CredentialsObject(`${distEndpoint}/s3credentials`);


test.beforeEach((t) => {
  t.context.bucketConfig = {
    private: { name: randomId('private'), type: 'private' },
    protected: { name: randomId('protected'), type: 'protected' },
    public: { name: randomId('public'), type: 'public' }
  };
  t.context.buckets = new BucketsConfig(t.context.bucketConfig);
});

test('mapCNMTypeToCMRType returns a mapping', (t) => {
  const expected = 'GET RELATED VISUALIZATION';
  const actual = mapCNMTypeToCMRType('browse');
  t.is(expected, actual);
});

test('mapCNMTypeToCMRType returns a default', (t) => {
  const expected = 'GET DATA';
  const actual = mapCNMTypeToCMRType(undefined);
  t.is(expected, actual);
});

test('returns correct url for protected data', (t) => {
  const movedFiles = [
    {
      key: 'some/path/protected-file.hdf',
      bucket: t.context.bucketConfig.protected.name
    }
  ];
  const expected = [
    {
      URL: `${distEndpoint}/${t.context.bucketConfig.protected.name}/some/path/protected-file.hdf`,
      Description: 'File to download',
      URLDescription: 'File to download',
      Type: 'GET DATA'
    }
  ];

  const actual = constructOnlineAccessUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets
  });

  t.deepEqual(actual, expected);
});

test('Returns correct url object for public data.', (t) => {
  const publicBucketName = t.context.bucketConfig.public.name;
  const movedFiles = [
    {
      key: 'some/path/browse_image.jpg',
      bucket: publicBucketName
    }
  ];
  const expected = [
    {
      URL: `${distEndpoint}/${publicBucketName}/some/path/browse_image.jpg`,
      Description: 'File to download',
      URLDescription: 'File to download',
      Type: 'GET DATA'
    }
  ];

  const actual = constructOnlineAccessUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets
  });

  t.deepEqual(actual, expected);
});


test('Returns empty list for private data.', (t) => {
  const privateBucket = t.context.bucketConfig.private.name;
  const movedFiles = [
    {
      key: 'some/path/top/secretfile',
      bucket: privateBucket
    }
  ];
  const actual = constructOnlineAccessUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets
  });

  t.deepEqual(actual, []);
});

test('returns an array of correct url objects given a list of moved files.', (t) => {
  const movedFiles = [
    {
      key: 'hidden/secretfile.gpg',
      bucket: t.context.bucketConfig.private.name,
      type: 'data'
    },
    {
      key: 'path/publicfile.jpg',
      bucket: t.context.bucketConfig.public.name,
      type: 'browse'
    },
    {
      key: 'another/path/protected.hdf',
      bucket: t.context.bucketConfig.protected.name,
      type: 'data'
    }
  ];

  const expected = [
    {
      URL: `${distEndpoint}/${t.context.bucketConfig.protected.name}/another/path/protected.hdf`,
      Description: 'File to download',
      URLDescription: 'File to download',
      Type: 'GET DATA'
    },
    {
      URL: `${distEndpoint}/${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      Description: 'File to download',
      URLDescription: 'File to download',
      Type: 'GET RELATED VISUALIZATION'
    }
  ];

  const actual = constructOnlineAccessUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets
  });

  t.deepEqual(actual.sort(sortByURL), expected.sort(sortByURL));
});

test('constructRelatedUrls returns expected array when called with file list', (t) => {
  const movedFiles = [
    {
      key: 'hidden/secretfile.gpg',
      bucket: t.context.bucketConfig.private.name
    },
    {
      key: 'path/publicfile.jpg',
      bucket: t.context.bucketConfig.public.name
    },
    {
      key: 'another/path/protected.hdf',
      bucket: t.context.bucketConfig.protected.name
    }
  ];

  const expected = [
    {
      URL: `${distEndpoint}/${t.context.bucketConfig.protected.name}/another/path/protected.hdf`,
      Description: 'File to download',
      Type: 'GET DATA'
    },
    {
      URL: `${distEndpoint}/${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      Description: 'File to download',
      Type: 'GET DATA'
    },
    omit(s3CredentialsEndpointObject, 'URLDescription')
  ];

  const actual = constructRelatedUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets
  });

  t.deepEqual(actual.sort(sortByURL), expected.sort(sortByURL));
});

test('constructRelatedUrls returns expected array when called with an empty file list', (t) => {
  const movedFiles = [];
  const expected = [omit(s3CredentialsEndpointObject, 'URLDescription')];

  const actual = constructRelatedUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets
  });

  t.deepEqual(actual, expected);
});

test.serial('returns correct links with s3 cmrGranuleUrlType', (t) => {
  const movedFiles = [
    {
      key: 'path/publicfile.jpg',
      bucket: t.context.bucketConfig.public.name,
      filename: `s3://${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      type: 'browse'
    }
  ];

  const expected = [
    {
      URL: `s3://${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      Description: 'File to download',
      URLDescription: 'File to download',
      Type: 'GET RELATED VISUALIZATION'
    }
  ];

  const actual = constructOnlineAccessUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets,
    cmrGranuleUrlType: 's3'
  });

  t.deepEqual(actual, expected.sort(sortByURL));
});

test.serial('returns no links when cmrGranuleUrlType is none', (t) => {
  const movedFiles = [
    {
      key: 'path/publicfile.jpg',
      bucket: t.context.bucketConfig.public.name,
      filename: `s3://${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      type: 'browse'
    }
  ];

  const actual = constructOnlineAccessUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets,
    cmrGranuleUrlType: 'none'
  });

  t.deepEqual(actual, []);
});

test('constructRelatedUrls returns s3 urls when cmrGranuleUrlType is s3', (t) => {
  const movedFiles = [
    {
      key: 'path/publicfile.jpg',
      bucket: t.context.bucketConfig.public.name,
      filename: `s3://${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      type: 'browse'
    }
  ];

  const expected = [
    {
      URL: `s3://${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      Description: 'File to download',
      Type: 'GET RELATED VISUALIZATION'
    },
    omit(s3CredentialsEndpointObject, 'URLDescription')
  ];

  const actual = constructRelatedUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets,
    cmrGranuleUrlType: 's3'
  });

  t.deepEqual(actual, expected);
});

test('constructRelatedUrls returns just s3 credentials url when cmrGranuleUrlType is s3', (t) => {
  const movedFiles = [
    {
      key: 'path/publicfile.jpg',
      bucket: t.context.bucketConfig.public.name,
      filename: `s3://${t.context.bucketConfig.public.name}/path/publicfile.jpg`,
      type: 'browse'
    }
  ];

  const actual = constructRelatedUrls({
    files: movedFiles,
    distEndpoint,
    buckets: t.context.buckets,
    cmrGranuleUrlType: 'none'
  });

  t.deepEqual(actual, [omit(s3CredentialsEndpointObject, 'URLDescription')]);
});
