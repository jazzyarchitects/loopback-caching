"use strict";

var redis = require('node-redis');
var client = redis.createClient();

var env = process.env.NODE_ENV || 'development';
function debug(message){
  if(env === 'development')
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

module.exports = function(Model, options){
  debug("Caching enabled for "+Model.modelName);
  Model.on('attached', function(){
    var find = Model.find;
    Model.find = function(filter, include, callback){
      if(typeof(include) == "function")
        callback = include;

      debug("Filter: "+JSON.stringify(filter));
      var where = filter.where;
      if(where){
        var keys = Object.keys(where);
        if(keys.length > 1 || keys[0] !== 'id'){
          if(!callback){
            return find.call(Model, filter, include, callback);
          }
          return find.call(Model, filter, function(err, results){
            if(!err){
              callback(null, results);
            }else{
              callback(err, null);
            }
          });
        }
      }
      var key = Model.modelName+".find."+encodeURIComponent(JSON.stringify(filter));
      client.get(key, function(err, reply){
        reply  = JSON.parse(reply);
        if(err){
          debug("Error while getting from redis cache: key="+Model.modelName+".find."+filter+"       "+JSON.stringify(err));
        }
        if(reply == null || reply == undefined || reply == []){
          find.call(Model, filter, function(err, results){
            if(!err){
              debug("Copied from db to redis: "+JSON.stringify(results));
              client.set(key, JSON.stringify(results));
              client.expire(key, (options.ttl || 24*60*60));
              callback(null, results);
            }else{
              debug("Error : "+JSON.stringify(err));
              callback(err, null);
            }
          });
        }else{
          debug("Sending from cache: "+key);
          process.nextTick(function(){
            callback(err, reply);
          });
        }
      });
      var args = [].slice.call(arguments);
      // return find.apply(this, args);
    };
  });

  Model.observe('after save', function(ctx, next){
    console.log("ctx.instance: "+JSON.stringify(ctx)+"\n"+JSON.stringify(ctx.data));
    var id = ctx.where.id || ctx.data.id || ctx.instance.id || ctx.currentInstance.id;
    client.del(Model.modelName+".find.%7B%22where%22%3A%7B%22id%22%3A"+id+"%7D%7D");
    client.del(Model.modelName+".find.%7B%22where%22%3A%7B%22id%22%3A"+id+"%7D%2C%22limit%22%3A1%7D");
    debug("Clear cache for "+Model.modelName+" : id="+id);
    next();
  });

};


//Replace Order.find.%7B%22where%22%3A%7B%22id%22%3A2%7D%7D
