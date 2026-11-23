'use strict';

/** In-memory order table, kept sorted by id (ids are increasing integers). */
const orders = [];

function seed(count) {
  orders.length = 0;
  for (let id = 1; id <= count; id++) { orders.push({ id, customer: `c${id % 7}`, cents: (id * 137) % 5000 + 100 }); }
}

function insert(order) {
  orders.push(order);
  orders.sort((a, b) => a.id - b.id);
}

seed(120);

module.exports = { orders, seed, insert };
