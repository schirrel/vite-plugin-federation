import type { RemotesConfig, VitePluginFederationOptions } from 'types'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'
import type { AcornNode, TransformPluginContext } from 'rollup'
import { getModuleMarker, parseRemoteOptions, removeNonLetter } from '../utils'
import { builderInfo, parsedOptions } from '../public'
import { basename, dirname } from 'path'
import type { PluginHooks } from '../../types/pluginHooks'
import { readFileSync } from 'fs'

export function prodRemotePlugin(
  options: VitePluginFederationOptions
): PluginHooks {
  parsedOptions.prodRemote = parseRemoteOptions(options)
  const remotes: { id: string; regexp: RegExp; config: RemotesConfig }[] = []
  for (const item of parsedOptions.prodRemote) {
    remotes.push({
      id: item[0],
      regexp: new RegExp(`^${item[0]}/.+?`),
      config: item[1]
    })
  }

  return {
    name: 'originjs:remote-production',
    virtualFile: {
      __federation__: `
const remotesMap = {
  ${remotes
    .map(
      (remote) =>
        `'${remote.id}':{url:'${remote.config.external[0]}',format:'${remote.config.format}',from:'${remote.config.from}'}`
    )
    .join(',\n  ')}
};
const loadJS = (url, fn) => {
  const script = document.createElement('script')
  script.type = 'text/javascript';
  script.onload = fn;
  script.src = url;
  document.getElementsByTagName('head')[0].appendChild(script);
}
const scriptTypes = ['var'];
const importTypes = ['esm', 'systemjs']
function get(name){
  return __federation_import(name).then(module => ()=>module?.default ?? module)
}
const shareScope = {
  ${getModuleMarker('shareScope')}
};
async function __federation_import(name){
  return import(name);
}
const initMap = Object.create(null);
async function __federation_method_ensure(remoteId) {
  const remote = remotesMap[remoteId];
  if (!remote.inited) {
    if (scriptTypes.includes(remote.format)) {
      // loading js with script tag
      return new Promise(resolve => {
        const callback = () => {
          if (!remote.inited) {
            remote.lib = window[remoteId];
            remote.lib.init(shareScope)
            remote.inited = true;
          }
          resolve(remote.lib);
        }
        loadJS(remote.url, callback);
      });
    } else if (importTypes.includes(remote.format)) {
      // loading js with import(...)
      return new Promise(resolve => {
        import(/* @vite-ignore */ remote.url).then(lib => {
          if (!remote.inited) {
            lib.init(shareScope);
            remote.lib = lib;
            remote.lib.init(shareScope);
            remote.inited = true;
          }
          resolve(remote.lib);
        })
      })
    }
  } else {
    return remote.lib;
  }
}

function __federation_method_unwrapDefault(module) {
  return module?.__esModule ? module['default'] : module
}

function __federation_method_wrapDefault(module ,need){
  if (!module?.default && need) {
    let obj = Object.create(null);
    obj.default = module;
    obj.__esModule = true;
    return obj;
  }
  return module; 
}

function __federation_method_getRemote(remoteName,  componentName){
  return __federation_method_ensure(remoteName).then((remote) => remote.get(componentName).then(factory => factory()));
}
export {__federation_method_ensure, __federation_method_getRemote , __federation_method_unwrapDefault , __federation_method_wrapDefault}
`
    },

    async transform(this: TransformPluginContext, code: string, id: string) {
      if (builderInfo.isShared) {
        for (const sharedInfo of parsedOptions.prodShared) {
          if (!sharedInfo[1].emitFile) {
            sharedInfo[1].emitFile = this.emitFile({
              type: 'chunk',
              id: sharedInfo[1].id ?? sharedInfo[0],
              fileName: `${
                builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
              }${
                sharedInfo[1].root ? sharedInfo[1].root[0] + '/' : ''
              }__federation_shared_${removeNonLetter(sharedInfo[0])}.js`,
              preserveSignature: 'allow-extension'
            })
          }
        }

        if (id === '\0virtual:__federation_fn_import') {
          const moduleMapCode = parsedOptions.prodShared
            .map(
              (sharedInfo) =>
                `'${removeNonLetter(
                  sharedInfo[0]
                )}':{get:()=>()=>__federation_import('./${
                  sharedInfo[1].root ? `${sharedInfo[1].root[0]}/` : ''
                }${basename(
                  this.getFileName(sharedInfo[1].emitFile)
                )}'),import:${sharedInfo[1].import}${
                  sharedInfo[1].requiredVersion
                    ? `,requiredVersion:'${sharedInfo[1].requiredVersion}'`
                    : ''
                }}`
            )
            .join(',')
          return code.replace(
            getModuleMarker('moduleMap', 'var'),
            `{${moduleMapCode}}`
          )
        }

        if (id === '\0virtual:__federation_lib_semver') {
          const federationId = (
            await this.resolve('@originjs/vite-plugin-federation')
          )?.id
          const satisfyId = `${dirname(federationId!)}/satisfy.js`
          return readFileSync(satisfyId, { encoding: 'utf-8' })
        }
      }

      if (builderInfo.isRemote) {
        for (const expose of parsedOptions.prodExpose) {
          if (!expose[1].emitFile) {
            expose[1].emitFile = this.emitFile({
              type: 'chunk',
              id: expose[1].id,
              fileName: `${
                builderInfo.assetsDir ? builderInfo.assetsDir + '/' : ''
              }__federation_expose_${removeNonLetter(expose[0])}.js`,
              name: `__federation_expose_${removeNonLetter(expose[0])}`,
              preserveSignature: 'allow-extension'
            })
          }
        }
        if (id === '\0virtual:__remoteEntryHelper__') {
          for (const expose of parsedOptions.prodExpose) {
            code = code.replace(
              `\${__federation_expose_${expose[0]}}`,
              `./${basename(this.getFileName(expose[1].emitFile))}`
            )
          }
          return code
        }
      }

      if (builderInfo.isHost) {
        if (id === '\0virtual:__federation__') {
          const res: string[] = []
          parsedOptions.prodShared.forEach((arr) => {
            const sharedName = removeNonLetter(arr[0])
            const obj = arr[1]
            let str = ''
            if (typeof obj === 'object') {
              const fileName = `./${basename(this.getFileName(obj.emitFile))}`
              str += `get:()=>get('${fileName}'), loaded:1`
              res.push(`'${sharedName}':{'${obj.version}':{${str}}}`)
            }
          })
          return code.replace(getModuleMarker('shareScope'), res.join(','))
        }

        let ast: AcornNode | null = null
        try {
          ast = this.parse(code)
        } catch (err) {
          console.error(err)
        }
        if (!ast) {
          return null
        }

        const magicString = new MagicString(code)
        let requiresRuntime = false
        walk(ast, {
          enter(node: any) {
            if (
              (node.type === 'ImportExpression' ||
                node.type === 'ImportDeclaration') &&
              node.source?.value?.indexOf('/') > -1
            ) {
              const moduleId = node.source.value
              const remote = remotes.find((r) => r.regexp.test(moduleId))
              const needWrap = remote?.config.from === 'vite'
              if (remote) {
                requiresRuntime = true
                const modName = `.${moduleId.slice(remote.id.length)}`
                switch (node.type) {
                  case 'ImportExpression': {
                    magicString.overwrite(
                      node.start,
                      node.end,
                      `__federation_method_getRemote(${JSON.stringify(
                        remote.id
                      )} , ${JSON.stringify(
                        modName
                      )}).then(module=>__federation_method_wrapDefault(module, ${needWrap}))`
                    )
                    break
                  }
                  case 'ImportDeclaration': {
                    if (node.specifiers?.length) {
                      const afterImportName = `__federation_var_${moduleId.replace(
                        /[@/\\.-]/g,
                        ''
                      )}`
                      magicString.overwrite(
                        node.start,
                        node.end,
                        `const ${afterImportName} = await __federation_method_getRemote(${JSON.stringify(
                          remote.id
                        )} , ${JSON.stringify(modName)});`
                      )
                      let deconstructStr = ''
                      node.specifiers.forEach((spec) => {
                        // default import , like import a from 'lib'
                        if (spec.type === 'ImportDefaultSpecifier') {
                          magicString.appendRight(
                            node.end,
                            `\n let ${spec.local.name} = __federation_method_unwrapDefault(${afterImportName}) `
                          )
                        } else if (spec.type === 'ImportSpecifier') {
                          //  like import {a as b} from 'lib'
                          const importedName = spec.imported.name
                          const localName = spec.local.name
                          deconstructStr += `${
                            importedName === localName
                              ? localName
                              : `${importedName} : ${localName}`
                          },`
                        } else if (spec.type === 'ImportNamespaceSpecifier') {
                          //  like import * as a from 'lib'
                          magicString.appendRight(
                            node.end,
                            `let {${spec.local.name}} = ${afterImportName}`
                          )
                        }
                      })
                      if (deconstructStr.length > 0) {
                        magicString.appendRight(
                          node.end,
                          `\n let {${deconstructStr.slice(
                            0,
                            -1
                          )}} = ${afterImportName}`
                        )
                      }
                    }
                    break;
                  }
                }
              }
            }
          }
        })

        if (requiresRuntime) {
          magicString.prepend(
            `import {__federation_method_ensure, __federation_method_getRemote , __federation_method_wrapDefault , __federation_method_unwrapDefault} from '__federation__';\n\n`
          )
        }

        return {
          code: magicString.toString(),
          map: null
        }
      }
    }
  }
}
