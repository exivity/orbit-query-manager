import Store from '@orbit/store'

import {
  Term,
  OngoingQueries,
  RecordObject,
  Expressions,
  Queries,
  Subscriptions,
  Statuses,
  QueryCacheOptions,
  Listener,
} from './types'
import { Transform, RecordOperation, RecordIdentity } from '@orbit/data'
import { identityIsEqual, shouldUpdate } from './helpers'

export class QueryManager<E extends { [key: string]: any } = any>  {
  _extensions: E
  _store: Store
  _ongoingQueries: OngoingQueries

  subscriptions: Subscriptions
  statuses: Statuses

  constructor (orbitStore: Store, extensions?: E) {
    this._extensions = extensions || {} as E
    this._store = orbitStore
    this._ongoingQueries = {}

    this.subscriptions = {}
    this.statuses = {}
  }

  registerQuery (queries: Queries) {
    const terms = this._extractTerms(queries)
    const queryRef = JSON.stringify(terms)

    if (!this.subscriptions[queryRef]) {
      this.subscriptions[queryRef] = { listeners: [], terms }
      this._store.on('transform', this._compare.bind(this, queryRef))
    }
    return queryRef
  }

  subscribe (queryRef: string, listener: () => void) {
    this.subscriptions[queryRef].listeners.push(listener)
  }

  _extractTerms (queries: Queries): Term[] {
    return Object.keys(queries).sort().map(
      (key) => ({ key, expression: queries[key](this._store.queryBuilder).expression as Expressions })
    )
  }


  unsubscribe (queryRef: string, listener: Listener) {
    this.subscriptions[queryRef].listeners =
      this.subscriptions[queryRef].listeners.filter(item => item === listener)

    if (this.subscriptions[queryRef].listeners.length === 0) {
      if (this._ongoingQueries[queryRef] && this.statuses[queryRef].loading) {
        this._ongoingQueries[queryRef].afterRequestQueue.push(() => {
          delete this.subscriptions[queryRef]
          delete this.statuses[queryRef]
        })
      } else {
        delete this.subscriptions[queryRef]
        delete this.statuses[queryRef]
      }

      this._store.off('transform', this._compare.bind(this, queryRef))
    }
  }

  query (queryRef: string) {
    if (!this._ongoingQueries[queryRef]) {
      this._query(queryRef)
    }
  }

  _query (queryRef: string) {
    const terms = this.subscriptions[queryRef].terms

    const queries: Promise<RecordObject>[] = terms
      .map(({ key, expression }) =>
        new Promise((resolve, reject) => {
          this._store.query(expression)
            .then(record => resolve({ [key]: record }))
            .catch(reject)
        })
      )

    this.statuses[queryRef] = { error: null, loading: false }

    this._ongoingQueries[queryRef] = { afterRequestQueue: [], request: queries }

    Promise.all(this._ongoingQueries[queryRef].request)
      .then(() => {

        this.statuses[queryRef].loading = false

        this._ongoingQueries[queryRef].afterRequestQueue.forEach(fn => fn())
        this.subscriptions[queryRef].listeners.forEach(listener => listener())

        delete this._ongoingQueries[queryRef]
      })
      .catch(error => {

        this.statuses[queryRef].loading = false
        this.statuses[queryRef].error = error

        this._ongoingQueries[queryRef].afterRequestQueue.forEach(fn => fn())
        this.subscriptions[queryRef].listeners.forEach(listener => listener())

        delete this._ongoingQueries[queryRef]
      })
  }

  queryCache (terms: Term[], { beforeQuery, onQuery, onError }: QueryCacheOptions<E> = {}): RecordObject | null {
    let cancel = false
    if (beforeQuery) {
      for (let i = 0; i < terms.length; i++) {
        const result = beforeQuery(terms[i].expression, this._extensions)
        if (result === true) {
          cancel = true
          break
        }
      }
    }

    if (!cancel) {
      try {
        const res = terms.map(({ key, expression }) =>
          ({ [key]: this._store.cache.query(expression) })
        ).reduce((acc, result) => ({ ...acc, ...result }), {})

        onQuery && onQuery(res, this._extensions)
        return res
      } catch (err) {
        onError && onError(err, this._extensions)
      }
    }

    return null
  }

  _compare (queryRef: string, transform: Transform) {
    const operations = transform.operations as RecordOperation[]

    const records: RecordIdentity[] = []
    const relatedRecords: RecordIdentity[] = []

    operations.forEach(operation => {
      operation && operation.record && records.push(operation.record)

      switch (operation.op) {
        case 'addToRelatedRecords':
        case 'removeFromRelatedRecords':
        case 'replaceRelatedRecord':
          operation.relatedRecord && relatedRecords.push(operation.relatedRecord)
          break

        case 'replaceRelatedRecords':
          operation.relatedRecords.forEach(record => relatedRecords.push(record))
          break
      }
    })

    const terms = this.subscriptions[queryRef].terms

    if (shouldUpdate(terms, records, relatedRecords)) {
      this.subscriptions[queryRef].listeners.forEach(listener => listener())
    }
  }
}