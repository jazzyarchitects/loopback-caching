"use strict";
var redis = require('node-redis');
var async = require('async');
var loopback = require('loopback');
var client = redis.createClient();
var env = process.env.NODE_ENV || 'development';

function debug(message){
  if(env === 'development' || env === 'test')
    console.log(message);
  return;
}

var hooks = {
  access: ['find', 'findOne', 'findById', 'exists', 'count', 'upsert', 'findOrCreate', 'deleteAll', 'deleteById', 'updateAll'],
  beforeSave: ['create', 'upsert', 'findOrCreate', 'updateAll', 'prototype.save'],
  afterSave: ['create', 'upsert', 'findOrCreate', 'updateAll', 'prototype.save'],
  beforeDelete: ['deleteAll','deleteAll','prototype.delete'],
  afterDelete: ['deleteAll','deleteAll','prototype.delete']
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

  **/

  module.exports = function(Model, options){

  debug("Caching enabled for "+Model.modelName);

  var find = Model.find;

  // Overriding find operation for the Model
  Model.on('attached', function(){
    find = Model.find;
    Model.find = function(filter, include, callback){

      return new Promise(function(resolve, reject){
        debug("Model name: "+Model.modelName);
        var args = arguments;
        if(typeof(include) === "function")
          callback = include;
        if(typeof(filter) === "function"){
          callback = filter;
          filter = {};
        }
        if(!filter){
          filter = {}
        }
        var key = Model.modelName+"_query_"+encodeURIComponent(JSON.stringify(filter));
        client.get(key, function(err, reply){
          if(err){
            debug("Error while getting from redis cache: key="+Model.modelName+".find."+filter+"       "+JSON.stringify(err));
          }
          if(reply)
            reply = reply.toString();
          else
            debug("Empty reply: "+reply);
          if(err || reply == null || reply == undefined || reply == []){
            reply  = JSON.parse(reply);
            find.call(Model, filter, function(err, results){
              if(!err){
                debug("Copied from db to redis: "+JSON.stringify(results));
                debug(results);
                var ids = [];
                for(var result of results){
                  ids.push(result.id)
                }
                debug("Ids: "+JSON.stringify(ids));
                var __results = [];
                for(var result of results){
                  __results.push(result["__data"]);
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

              for(var i of ids){
                i = Model.modelName+"_id_"+i;
                debug("Pushing to id array: "+i+"\n: "+key);
                client.rpush(i, key);
              }
              client.set(key, JSON.stringify(__results));

              // debug("Arguments: "+JSON.stringify(args));
              // if(!callback){
              //   callback = args[args.length -1];
              // }
              if(callback)
                return callback(null, results);
              resolve(results);
            }else{
              debug("Error : "+JSON.stringify(err));
              if(callback)
                return callback(err, null);
              reject(err);
            }

          });
          }else{
            debug("Sending from cache: "+key);
            // debug("Reply: "+reply);
            process.nextTick(function(){
              var replies = [];
              reply = JSON.parse(reply);
              if(reply[0]){
                var replies = [];

                debug("==================Reply====================");
                debug(Model.modelName+":");
                debug(reply);
                debug("======================================");

                var keys = Object.keys(reply);
                var relations = Model.definition.settings.relations;
                var __keys = Object.keys(relations);

                for(var key of keys) {
                  debug("_________________________");
                  debug(reply[key]);
                  debug("_________________________");

                  var model = new Model(reply[key]);
                  var r = reply[key];
                  for(var _key of __keys){
                    if(r[_key]){
                      model.__data[_key] = r[_key];
                      // model.__cachedRelations[_key] = r[_key];
                      // model.__data[_key] = function(){
                        // return r[_key];
                      // }
                    }
                  }
                  replies.push(model);
                }

                debug("=============--------------------------===================");
                debug(Model.modelName+":");
                debug(replies);
                debug("===================-------------===========================");
                if(callback){
                  return callback(err, replies);
                }
                resolve(replies);
                return;
              }
              reply = new Model(reply);
              debug("Reply type: "+JSON.stringify(reply)+"\n: "+reply.constructor.name);
              if(callback)
                return callback(err, reply);
              resolve(reply);
              // process.exit();
            });
          }
        });



});

};
});

  //Remove key from redis db on change so that old data is not sent
  Model.observe('after save', function(ctx, next){
    debug("Ctx after save: "+JSON.stringify(ctx));
    var id = null;
    if(ctx.where && ctx.where.id){
      id = ctx.where.id;
    }else if(ctx.data && ctx.data.id){
      id = ctx.data.id;
    }else if(ctx.instance && ctx.instance.id){
      id = ctx.instance.id;
    }else if(ctx.currentInstance && ctx.currentInstance.id){
      id = ctx.currentInstance.id;
    }
    if(id){
      return deleteCacheById(id, null, next);
    }else{
      __deleteCache(ctx.where || {}, null, next);
    }
  });

  Model.deleteCache = function(filter, callback){
    __deleteCache(filter, callback);
  }

  //If user wants to define functions which force refresh the cache for particular filter
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
  **/

  function __deleteCache(filter, callback, next){
    filter.where = filter.where || {};
    filter.fields = {id: true};
    find.call(Model, filter, function(err, results){
      async.forEachLimit(results, 5, function(result, _cb){
        deleteCacheById(result.id, _cb);
      }, function(){
        if(callback){
          callback();
        }else{
          next();
        }
      });
    });
  }

  function deleteCacheById(id, callback, next){
    var key = Model.modelName+"_id_"+id;
    debug("key: "+key);
    client.lrange(key, 0, -1, function(err, reply){
      debug("Client lrange reply: "+reply);
      reply = reply.toString();
      var rawKeys = reply.split(',');

      for(var i = 0; i < rawKeys.length; i++){
        debug("Deleting key: "+rawKeys[i]);
        client.del(rawKeys[i]);
        client.lrem(key, 0, rawKeys[i]);
      }
      if(callback){
        callback();
      }else{
        next();
      }
    });
  }


};
