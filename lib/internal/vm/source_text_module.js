'use strict';

const { Object, SafePromise } = primordials;

const { isModuleNamespaceObject } = require('internal/util/types');
const { isContext } = internalBinding('contextify');
const {
  ERR_INVALID_ARG_TYPE,
  ERR_VM_MODULE_ALREADY_LINKED,
  ERR_VM_MODULE_DIFFERENT_CONTEXT,
  ERR_VM_MODULE_LINKING_ERRORED,
  ERR_VM_MODULE_NOT_MODULE,
  ERR_VM_MODULE_STATUS,
} = require('internal/errors').codes;
const {
  getConstructorOf,
  customInspectSymbol,
  emitExperimentalWarning
} = require('internal/util');
const {
  validateInt32,
  validateUint32,
  validateString,
} = require('internal/validators');

const binding = internalBinding('module_wrap');
const {
  ModuleWrap,
  kUninstantiated,
  kInstantiating,
  kInstantiated,
  kEvaluating,
  kEvaluated,
  kErrored,
} = binding;

const STATUS_MAP = {
  [kUninstantiated]: 'unlinked',
  [kInstantiating]: 'linking',
  [kInstantiated]: 'linked',
  [kEvaluating]: 'evaluating',
  [kEvaluated]: 'evaluated',
  [kErrored]: 'errored',
};

let globalModuleId = 0;
const defaultModuleName = 'vm:module';
const perContextModuleId = new WeakMap();
const wrapToModuleMap = new WeakMap();

const kNoError = Symbol('kNoError');

class SourceTextModule {
  #wrap;
  #specifier;
  #context;
  #dependencySpecifiers;
  #statusOverride;
  #error = kNoError;

  constructor(source, options = {}) {
    emitExperimentalWarning('vm.SourceTextModule');

    validateString(source, 'source');
    if (typeof options !== 'object' || options === null)
      throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);

    const {
      context,
      lineOffset = 0,
      columnOffset = 0,
      initializeImportMeta,
      importModuleDynamically,
    } = options;

    if (context !== undefined) {
      if (typeof context !== 'object' || context === null) {
        throw new ERR_INVALID_ARG_TYPE('options.context', 'Object', context);
      }
      if (!isContext(context)) {
        throw new ERR_INVALID_ARG_TYPE('options.context', 'vm.Context',
                                       context);
      }
    }

    validateInt32(lineOffset, 'options.lineOffset');
    validateInt32(columnOffset, 'options.columnOffset');

    if (initializeImportMeta !== undefined &&
        typeof initializeImportMeta !== 'function') {
      throw new ERR_INVALID_ARG_TYPE(
        'options.initializeImportMeta', 'function', initializeImportMeta);
    }

    if (importModuleDynamically !== undefined &&
        typeof importModuleDynamically !== 'function') {
      throw new ERR_INVALID_ARG_TYPE(
        'options.importModuleDynamically', 'function', importModuleDynamically);
    }

    let { specifier } = options;
    if (specifier !== undefined) {
      validateString(specifier, 'options.specifier');
    } else if (context === undefined) {
      specifier = `${defaultModuleName}(${globalModuleId++})`;
    } else if (perContextModuleId.has(context)) {
      const curId = perContextModuleId.get(context);
      specifier = `${defaultModuleName}(${curId})`;
      perContextModuleId.set(context, curId + 1);
    } else {
      specifier = `${defaultModuleName}(0)`;
      perContextModuleId.set(context, 1);
    }

    this.#wrap = new ModuleWrap(
      source, specifier, context,
      lineOffset, columnOffset,
    );
    wrapToModuleMap.set(this.#wrap, this);
    this.#specifier = specifier;
    this.#context = context;

    binding.callbackMap.set(this.#wrap, {
      initializeImportMeta,
      importModuleDynamically: importModuleDynamically ?
        importModuleDynamicallyWrap(importModuleDynamically) :
        undefined,
    });
  }

  get status() {
    if (this.#error !== kNoError) {
      return 'errored';
    }
    if (this.#statusOverride) {
      return this.#statusOverride;
    }
    return STATUS_MAP[this.#wrap.getStatus()];
  }

  get specifier() {
    return this.#specifier;
  }

  get context() {
    return this.#context;
  }

  get namespace() {
    if (this.#wrap.getStatus() < kInstantiated) {
      throw new ERR_VM_MODULE_STATUS('must not be unlinked or linking');
    }
    return this.#wrap.getNamespace();
  }

  get dependencySpecifiers() {
    if (this.#dependencySpecifiers === undefined) {
      this.#dependencySpecifiers = this.#wrap.getStaticDependencySpecifiers();
    }
    return this.#dependencySpecifiers;
  }

  get error() {
    if (this.#error !== kNoError) {
      return this.#error;
    }
    if (this.#wrap.getStatus() !== kErrored) {
      throw new ERR_VM_MODULE_STATUS('must be errored');
    }
    return this.#wrap.getError();
  }

  async link(linker) {
    if (typeof linker !== 'function') {
      throw new ERR_INVALID_ARG_TYPE('linker', 'function', linker);
    }
    if (this.status !== 'unlinked') {
      throw new ERR_VM_MODULE_ALREADY_LINKED();
    }

    await this.#link(linker);

    this.#wrap.instantiate();
  }

  #link = async function(linker) {
    this.#statusOverride = 'linking';
    const promises = this.#wrap.link(async (specifier) => {
      const module = await linker(specifier, this);
      try {
        module.#wrap;
      } catch {
        throw new ERR_VM_MODULE_NOT_MODULE();
      }
      if (module.context !== this.context) {
        throw new ERR_VM_MODULE_DIFFERENT_CONTEXT();
      }
      if (module.status === 'errored') {
        throw new ERR_VM_MODULE_LINKING_ERRORED();
      }
      if (module.status === 'unlinked') {
        await module.#link(linker);
      }
      return module.#wrap;
    });

    if (promises !== undefined) {
      try {
        await SafePromise.all(promises);
      } catch (e) {
        this.#error = e;
        throw e;
      } finally {
        this.#statusOverride = undefined;
      }
    }
  };


  async evaluate(options = {}) {
    if (typeof options !== 'object' || options === null) {
      throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }

    let timeout = options.timeout;
    if (timeout === undefined) {
      timeout = -1;
    } else {
      validateUint32(timeout, 'options.timeout', true);
    }
    const { breakOnSigint = false } = options;
    if (typeof breakOnSigint !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE('options.breakOnSigint', 'boolean',
                                     breakOnSigint);
    }
    const status = this.#wrap.getStatus();
    if (status !== kInstantiated &&
        status !== kEvaluated &&
        status !== kErrored) {
      throw new ERR_VM_MODULE_STATUS(
        'must be one of linked, evaluated, or errored'
      );
    }
    const result = this.#wrap.evaluate(timeout, breakOnSigint);
    return { __proto__: null, result };
  }

  static importModuleDynamicallyWrap(importModuleDynamically) {
    // Named declaration for function name
    const importModuleDynamicallyWrapper = async (...args) => {
      const m = await importModuleDynamically(...args);
      if (isModuleNamespaceObject(m)) {
        return m;
      }
      try {
        m.#wrap;
      } catch {
        throw new ERR_VM_MODULE_NOT_MODULE();
      }
      if (m.status === 'errored') {
        throw m.error;
      }
      return m.namespace;
    };
    return importModuleDynamicallyWrapper;
  }

  [customInspectSymbol](depth, options) {
    let ctor = getConstructorOf(this);
    ctor = ctor === null ? SourceTextModule : ctor;

    if (typeof depth === 'number' && depth < 0)
      return options.stylize(`[${ctor.name}]`, 'special');

    const o = Object.create({ constructor: ctor });
    o.status = this.status;
    o.specifier = this.specifier;
    o.context = this.context;
    return require('internal/util/inspect').inspect(o, options);
  }
}

// Declared as static to allow access to #wrap
const importModuleDynamicallyWrap =
  SourceTextModule.importModuleDynamicallyWrap;
delete SourceTextModule.importModuleDynamicallyWrap;

module.exports = {
  SourceTextModule,
  wrapToModuleMap,
  importModuleDynamicallyWrap,
};
