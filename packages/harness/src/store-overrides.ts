/**
 * A store whose named members are replaced, with every other member bound to the original.
 * A bound method is made once per original function, so `store.x === store.x` holds.
 */
export function withStoreOverrides<S extends object>(store: S, overrides: Partial<S>): S {
  const bound = new WeakMap<CallableFunction, CallableFunction>()
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (Object.hasOwn(overrides, prop)) return (overrides as Record<PropertyKey, unknown>)[prop]
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      let method = bound.get(value)
      if (method === undefined) {
        method = value.bind(target) as CallableFunction
        bound.set(value, method)
      }
      return method
    },
  })
}
