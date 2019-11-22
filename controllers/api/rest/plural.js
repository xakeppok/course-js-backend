const Router = require('@koa/router');
const save = require('./save');
const pluralize = require('pluralize');
const _ = require('lodash');

module.exports = (db, name, opts) => {
  const router = new Router();

  let collection = db.get(name);

  return router
    .get('/', list)
    .post('/', create, save(db))
    .get('/:id', show)
    .put('/:id', update, save(db))
    .patch('/:id', update, save(db))
    .delete('/:id', destroy, save(db))
    .routes();

  // GET /products
  // GET /products?category.name =  _lte=  _gte=  _ne=  _like=
  // GET /products?_start=1&_end=10
  // GET /products?_sort=category.name,id&order=desc,asc
  // GET /products?_embed=category,other
  // GET /categories?_refs=subcategory
  async function list(ctx, next) {

    await new Promise(resolve => setTimeout(resolve, 1000));

    let filters = {
      lte(compareWith, getter, value) {
        value = getter(value);
        if (value instanceof Date) {
          compareWith = new Date(compareWith);
          compareWith.setHours(23, 59, 59, 999);
        }
        // console.log("LOG", compareWith, value, getter(value));
        return value <= compareWith;
      },
      gte(compareWith, getter, value) {
        value = getter(value);
        if (value instanceof Date) {
          compareWith = new Date(compareWith);
          compareWith.setHours(0, 0, 0, 0);
        }
        return value >= compareWith;
      },
      eq(match, getter, value) {
        return getter(value) == match;
      },
      ne(match, getter, value) {
        return getter(value) != match;
      },
      like(match, getter, value) {
        // console.log(match, value, getter(value));
        return String(getter(value)).toLowerCase().includes(match.toLowerCase());
      }
    };

    let processingChain = {
      filters: [],
      sortFields: [],
      sortOrder: [],
      start: null,
      end: null,
      embed: [],
      refs: [] // not implemented, to embed items that reference each result, e.g. _refs=subcategory embeds subcategory where category=result id
    };

    let query = Object.assign({}, ctx.query);

    for (let [key, value] of Object.entries(query)) {
      let operator = key.match(/_[^_]+$/g);
      let field;

      if (operator) {
        operator = operator[0]; // ['_lte'] -> _lte
        field = key.slice(0, -operator.length);
        operator = operator.slice(1); // _lte -> lte
      } else {
        field = key;
        operator = 'eq';
      }

      let getter = db.createGetter(field);
      if (filters[operator]) {
        processingChain.filters.push(filters[operator].bind(null, value, getter));
      }

      if (field === '') {
        if (operator === 'sort') {
          processingChain.sortFields = value.split(',');
        }
        if (operator === 'order') {
          processingChain.sortOrder = value.split(',');
        }
        if (operator === 'start') {
          processingChain.start = +value;
        }
        if (operator === 'end') {
          processingChain.end = +value;
        }
        if (operator === 'embed') {
          processingChain.embed = value.split(',');
        }
        if (operator === 'refs') {
          processingChain.refs = value.split(',');
        }
      }
    }

    let results = collection.slice();
    for(let i=0; i<results.length; i++) {
      let result = results[i];
      if (!result) continue; // filtered out by a previous filter run
      for(let filter of processingChain.filters) {
        if (!filter(result)) {
          console.log("Removing", filter, result);
          results[i] = null;
          break;
        }
      }
    }


    results = results.filter(Boolean);

    // console.log(results.length, "BEFORE");

    for(let i = 0; i<processingChain.sortFields.length; i++) {
      let sortField = processingChain.sortFields[i];
      let order = processingChain.sortOrder[i] === 'desc' ? -1 : 1;

      let getter = db.createGetter(sortField);

      results.sort((a, b) =>
        getter(a) > getter(b) ? order :
        getter(a) == getter(b) ? 0  : -order);
    }

    // console.log(results.length, "AFTER");

    if (processingChain.start !== null) {
      results = results.slice(processingChain.start, processingChain.end == null ? results.length : processingChain.end);
      ctx.set('X-Total-Count', results.length);
      ctx.append('Access-Control-Expose-Headers', 'X-Total-Count');
    }

    // console.log(results.length, "AFTER");

    // before embedding copy objects, to avoid overwriting in db
    results = results.map(_.cloneDeep);

    for(let embedField of processingChain.embed) {
      for(let result of results) {
        if (result[embedField])  {
          // console.log(embedField, result[embedField]);

          // product.category = (get value from db)
          result[embedField] = db.getById(pluralize(embedField), result[embedField]);
        }
      }
    }

    ctx.body = results;

    await next();
  }

  // /GET /products/12
  async function show(ctx, next) {
    let result = db.getById(name, ctx.params.id);

    if (!result) {
      ctx.throw(404, "No such item");
    }

    if (ctx.query._embed) {
      for(let embedField of ctx.query._embed.split(',')) {
        if (result[embedField])  {
          result[embedField] = db.getById(pluralize(embedField), result[embedField]);
        }
      }
    }

    ctx.body = result;

    await next();
  }

  // POST /products
  async function create(ctx, next) {
    if (ctx.request.body.id && db.getById(collection, ctx.request.body.id)) {
      ctx.status = 409;
      ctx.body = {
        errors: {
          id: `ID already exists: ${ctx.request.body.id}`
        }
      };
      return await next();
    }

    let validate = db.getValidate(collection);

    if (!validate(ctx.request.body)) {
      ctx.body = validate.errors;
      ctx.status = 400;
      return await next();
    }

    collection.push(ctx.request.body);
    ctx.status = 201;
    return await next();
  }

  // PUT /name/:id -> replaces (adds if not exists)
  // PATCH /name/:id -> updates (errors if not exists)
  async function update(ctx, next) {
    const id = ctx.params.id;

    let resource = db.getById(name, id);

    if (!resource && ctx.request.method === 'PATCH') {
      ctx.throw(404, "No such item");
    }

    console.log(ctx.request);

    let newResource = (ctx.request.method === 'PATCH') ? Object.assign(_.cloneDeep(resource), ctx.request.body) : ctx.request.body;

    let validate = db.getValidate(name);

    if (!validate(newResource)) {
      ctx.body = validate.errors;
      ctx.status = 400;
      return await next();
    }

    collection.splice(collection.indexOf(resource), 1, newResource);

    ctx.body = newResource;

    await next()
  }

  // DELETE /name/:id
  async function destroy(ctx, next) {
    let resource = db.getById(name, id);

    if (!resource) {
      ctx.throw(404, "No such item");
    }

    collection.splice(collection.indexOf(resource), 1);

    ctx.body = {};
    await next();
  }

};
