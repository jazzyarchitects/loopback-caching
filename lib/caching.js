'use strict';

/* eslint-disable no-param-reassign */

// const redis = require('node-redis');
const async = require('async');
// const loopback = require('loopback');

// const client = redis.createClient();
const env = process.env.NODE_ENV || 'development';

function debug(message) {
  if (env === 'development' || env === 'test') console.log(message);
}

// eslint-disable-next-line no-unused-vars
const hooks = {
  access: [
    'find',
    'findOne',
    'findById',
    'exists',
    'count',
    'upsert',
    'findOrCreate',
    'deleteAll',
    'deleteById',
    'updateAll',
  ],
  beforeSave: ['create', 'upsert', 'findOrCreate', 'updateAll', 'prototype.save'],
  afterSave: ['create', 'upsert', 'findOrCreate', 'updateAll', 'prototype.save'],
  beforeDelete: ['deleteAll', 'deleteAll', 'prototype.delete'],
  afterDelete: ['deleteAll', 'deleteAll', 'prototype.delete'],
};

/**
  Hey all,

  Structure of loopback model item:
  suppose a findOne query returns order object, then order is a json containing following fields:

  __cachedRelations
  __data
  __dataSource
  __strict
  __persisted

  If you convert order to json, then hidden fields will be removed.
  If you want to convert to json without loosing hidden fields, then convert order["__data"] to json.
  Nothing will be lost.

  Cheers
  Jibin

  */

module.exports = function(Model, options) {
  debug('Caching enabled for ' + Model.modelName);

  let find = Model.find;
  const client = Model.app.redisClient;

  // Overriding find operation for the Model
  Model.on('attached', () => {
    find = Model.find;
    Model.find = function(filter, include, callback) {
      return new Promise(function(resolve, reject) {
        debug('Model name: ', Model.modelName);
        const args = arguments; // eslint-disable-line
        if (typeof include === 'function') callback = include;
        if (typeof filter === 'function') {
          callback = filter;
          filter = {};
        }
        if (!filter) {
          filter = {};
        }
        const key = `${Model.modelName}_query_${encodeURIComponent(JSON.stringify(filter))}`;
        client.get(key, (err, reply) => {
          if (err) {
            debug(
              `Error while getting from redis cache: key=${Model.modelName}.find.${JSON.stringify(filter)}`,
              JSON.stringify(err)
            );
          }
          if (reply) reply = reply.toString();
          else debug(`Empty reply: ${reply}`);
          if (err || !reply || (reply && reply.length <= 0)) {
            reply = JSON.parse(reply);
            find.call(Model, filter, (__err, results) => {
              if (!__err) {
                debug(`Copied from db to redis: ${JSON.stringify(results)}`);
                debug(results);
                const ids = [];
                for (const result of results) {
                  ids.push(result.id);
                }
                debug(`Ids: ${JSON.stringify(ids)}`);
                const __results = [];
                for (const result of results) {
                  __results.push(result && result.toJSON());
                }
                debug(__results);

                /* Loopback anatomy -- Uncomment to reveal loopbacks objects
              var _k = Object.keys(results[0]);
              for(var i=0;i<_k.length;i++){
                debug("\n\n\nindex="+i);
                debug(results[0][_k[i]]);
              }
              var __keys = Object.keys(results[0]["__data"]);
              debug("\n\n----------------------------------------------------------------");
              debug(__keys);
              */

                for (let i of ids) {
                  i = `${Model.modelName}_id_${i}`;
                  debug('Pushing to id array: ', i, '\n: ', key);
                  client.rpush(i, key);
                }
                client.set(key, JSON.stringify(__results));

                // debug("Arguments: "+JSON.stringify(args));
                // if(!callback){
                //   callback = args[args.length -1];
                // }
                if (callback) return callback(null, results);
                return resolve(results);
              } else {
                debug('Error : ', JSON.stringify(err));
                if (callback) return callback(err, null);
                return reject(err);
              }
            });
          } else {
            debug('Sending from cache: ', key);
            // debug("Reply: "+reply);
            process.nextTick(() => {
              let replies = [];
              reply = JSON.parse(reply);
              if (reply[0]) {
                replies = [];

                debug('==================Reply====================');
                debug(Model.modelName);
                debug(reply);
                debug('======================================');

                const keys = Object.keys(reply);
                const relations = Model.definition.settings.relations;

                for (const __key of keys) {
                  debug('_________________________');
                  debug(reply[__key]);
                  debug('_________________________');

                  const model = new Model(reply[__key]);
                  const r = reply[__key];
                  for (const _key of Object.keys(relations)) {
                    if (r[_key]) {
                      model.__data[_key] = r[_key];
                    }
                  }
                  replies.push(model);
                }

                debug('=============--------------------------===================');
                debug(Model.modelName, ':');
                debug(replies);
                debug('===================-------------===========================');
                if (callback) {
                  return callback(err, replies);
                }
                resolve(replies);
                return undefined;
              }
              reply = new Model(reply);
              debug('Reply type: ', JSON.stringify(reply), '\n: ', reply.constructor.name);
              if (callback) return callback(err, reply);
              return resolve(reply);
              // process.exit();
            });
          }
        });
      });
    };
  });

  // Remove key from redis db on change so that old data is not sent
  Model.observe('after save', (ctx, next) => {
    debug('Ctx after save: ', JSON.stringify(ctx));
    let id = null;
    if (ctx.where && ctx.where.id) {
      id = ctx.where.id;
    } else if (ctx.data && ctx.data.id) {
      id = ctx.data.id;
    } else if (ctx.instance && ctx.instance.id) {
      id = ctx.instance.id;
    } else if (ctx.currentInstance && ctx.currentInstance.id) {
      id = ctx.currentInstance.id;
    }
    if (id) {
      return deleteCacheById(id, null, next);
    } else {
      return __deleteCache(ctx.where || {}, null, next);
    }
  });

  Model.deleteCache = function(filter, callback) {
    __deleteCache(filter, callback);
  };

  // If user wants to define functions which force refresh the cache for particular filter
  /**
  if(options.deleteCacheFunctions){
    if(typeof(options.deleteCacheFunctions) === "array"){
      for(var i = 0; i<options.deleteCacheFunctions.length; i++){
        if(typeof(options.deleteCacheFunctions[i]) !== "string"){
          continue;
        }
        Model[options.deleteCacheFunctions[i]] = function(filter, callback){
          __deleteCache(filter, callback);
        }
      }
    }else if(typeof(options.deleteCacheFunctions) === "stringify"){
      Model[options.deleteCacheFunction] = function(filter, callback){
        __deleteCache(filter, callback);
      }
    }else{
      throw new Error("deleteCacheFunctions for "+Model.modelName+" should be given in form of [function1, function2, ..., functionN] or \"function1\"")
    }
  }
  */

  function __deleteCache(filter, callback, next) {
    filter.where = filter.where || {};
    filter.fields = { id: true };
    find.call(Model, filter, (err, results) => {
      async.forEachLimit(
        results,
        5,
        (result, _cb) => {
          deleteCacheById(result.id, _cb);
        },
        () => {
          if (callback) {
            callback();
          } else {
            next();
          }
        }
      );
    });
  }

  function deleteCacheById(id, callback, next) {
    const key = `${Model.modelName}_id_${id}`;
    debug('key: ', key);
    client.lrange(key, 0, -1, (err, reply) => {
      debug('Client lrange reply: ', reply);
      reply = reply.toString();
      const rawKeys = reply.split(',');

      for (let i = 0; i < rawKeys.length; i++) {
        debug('Deleting key: ', rawKeys[i]);
        client.del(rawKeys[i]);
        client.lrem(key, 0, rawKeys[i]);
      }
      if (callback) {
        callback();
      } else {
        next();
      }
    });
  }
};
