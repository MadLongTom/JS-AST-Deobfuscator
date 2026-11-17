# 旧式数据 eval 的显式假设

部分旧式播放器和框架直接用 eval 解析接口数据，缺少可静态证明的完整 JSON 校验链。这类 eval 在语法上能读取或修改外层名字，因此默认的动态作用域检查会保护它可见的字符串表、解码器和别名。仅凭 `responseText` 属性名、`typeof value === 'string'` 或一对括号，不能证明输入只包含数据。

`assumeDataEval: true` 允许调用方在已经核实数据契约的前提下，为人工分析显式采用这个额外假设。它只允许与 `profile: 'readable'` 一起使用，默认 `false`。选择 readable 本身不会启用它，safe 下开启会报告 `INVALID_OPTIONS`。

```js
const { deobfuscate } = require('js-ast-deobfuscator');

const result = deobfuscate(source, {
  filename: 'video-index.js',
  profile: 'readable',
  assumeDataEval: true,
  renameBindings: true,
  sourceMaps: true,
});

console.log(result.report.assumptions);
```

从仓库根目录运行时，将 require 改为 `require('./src')`。

CLI 的对应写法为：

```sh
node bin/js-ast-deobfuscator.js input.js --profile readable --assume-data-eval --rename -o readable.js --report readable.report.json --source-map
```

JSON 配置也接受 `"assumeDataEval": true`，遵循同样的类型、profile 和配置优先级规则。选项不是执行模式：工具始终只分析 AST，不运行输入中的 eval、Function 或其他代码。

## 数据契约与支持形状

显式假设包括：输入转换后的文本恰好是一个数据字面量表达式，只含字符串、数字、布尔值、null、数组和对象属性值；不含标识符引用、函数调用、函数、访问器、计算属性、展开、赋值或额外语句；未被局部绑定遮蔽的 `eval` 名字指向宿主的内建 eval。工具不会读取接口实际响应来验证这些条件。

目前支持两类直接调用形状：

```js
const result = eval('(' + response.responseText + ')');

eval('var d=' + response.responseText);
eval('var data=' + text);
eval('var subs=' + subtitleText);
```

括号表达式可以用于返回值或赋值。单变量 `var` 声明形态必须是独立表达式语句，因为 eval 的完成值在其他位置可能被观察。声明名字按合法标识符检查，不按 d/data/subs 名称白名单识别；`eval`、`arguments` 等特殊名字不接受。混淆后的固定前后缀须由字符串解码器先静态证明，不能根据变量或函数拼写猜测内容。

原 eval 调用及其数据入口保留，不会悄悄改成 `JSON.parse`。后者在语法接受范围、对象字面量语义和错误行为上存在差异；将两者替换并非这个选项的功能。参数表达式仍由原程序在原位置求值，工具不调用它的 getter、函数或字符串转换方法。

以下形状不会因为该选项而成为受信数据解析器：

```js
eval(code);
eval('(' + text + ')extra()');
eval('var d=call();' + text);
eval('let d=' + text);
eval('var d, other=' + text);
return eval('var d=' + text);
```

局部参数或变量遮蔽的 eval、多个实参、with 内的调用也不采用该假设。可选调用、成员调用和逗号调用等间接 eval 形式不会被改为直接调用。一个入口符合形状，不代表同一作用域的其他 eval 也被放行。

## 为什么 var 声明仍然形成屏障

`eval('var d=' + text)` 即使只解析数据，也会在非严格模式下引入或修改 `d`。仅删除所有动态风险、随后给其他变量重命名或内联到这个作用域，会遗漏动态名字解析和声明初始化的影响。

工具分别检查三件事：

- 引入名字的 binding 仍受保护，防止删除、重命名或常量传播绕过 eval 对该名字的作用。
- 所在函数或脚本的整个变量环境仍有 path/region 屏障，包括相邻词法块及其内部的移动目标。不能只保护 eval 所在文本块。
- 在数据契约下，无关字符串解码器不再被视为可由这段数据任意读取或修改。把已证明的纯解码结果替换成字符串字面量，使用独立于一般代码移动的风险查询。

因此，允许某处解码并不等于允许在该处内联任意表达式、删除任意辅助函数或移动一段控制流。未知 eval 与 with 仍按原规则处理。class 重建是另一个显式最终阶段，其严格模式、构造调用、枚举性和引用时序检查不会由本选项取消。

## 报告与来源映射

每处采用该假设的调用写入 `report.assumptions`，同时产生 `ASSUMED_DATA_EVAL` 诊断：

```js
{
  kind: 'variable-declaration', // 或 parenthesized-expression
  location: { line: 123, column: 4 },
  proven: false,
  introducedNames: ['data'],
  assumptions: [/* 调用方采用的数据契约 */]
}
```

行号从 1 开始，列号从 0 开始，位置来自原始 AST。重复迭代不会把相同站点反复加入假设列表。报告的 `input.sha256` 标记输入源码，`output.sha256` 标记最终输出；Source Map 指向最初输入，便于从生成文件回查原始站点。`proven: false` 区分显式契约假设和 JSON2 完整语法校验的自动证明。

默认模式仍保留任意未证明的直接 eval 风险。JSON2 的自动例外继续要求完整固定正则链、字符串转换、规范转义及无污染的相关内建方法；它不需要本选项。默认兼容、输入执行守卫和解码资源上限也保持独立。

## 超星样本复现

```sh
npm run sample:chaoxing
npm run sample:chaoxing -- --output artifacts/chaoxing-review
```

此命令调用 `scripts/chaoxing-sample.cjs`，读取仓库内的 `test/fixtures/chaoxing-video-index.obfuscated.js`、`chaoxing-videojs-ext.obfuscated.js` 和 `chaoxing.metadata.json`。脚本在处理前检查两份输入的固定字节数和 SHA-256。元数据记录脚本路径、缓存标记、来源说明和审阅日期；缓存标记不作为 SDK 语义版本，审阅日期也不冒充原始下载日期。

默认输出目录为 `artifacts/chaoxing/`，可使用 `--output` 指定其他目录。两份原始样本分别使用 `profile: 'readable'`、`assumeDataEval: true`、`renameBindings: true`、`sourceMaps: true` 和 `maxIterations: 50` 处理，不从旧的 readable 文件继续加工。

| 文件 | 内容 |
| --- | --- |
| `video-index.js`、`videojs-ext.js` | 保留原文件初始化次序的完整阅读产物 |
| 对应的 `.js.map` | 指向固定原始 fixture 的 Source Map，包含原始源码 |
| `video-index.report.json`、`videojs-ext.report.json` | 每轮 pass、诊断、逐站点假设、名称映射及输入输出指标 |
| `video-index.validation.json`、`videojs-ext.validation.json` | 转换前后审计、decoder 家族与别名残留、eval 形态和引入名字引用、关键业务标记 |
| `build-summary.json` | 输入输出哈希、构建选项、汇总指标及审计入口 |
| `tool-source-manifest.json` | 生成这些产物所用工具源码及依赖声明的指纹 |

脚本只进行离线静态变换和重新解析，不执行播放器代码，不登录网站，不播放课程，也不发送学习进度。默认关闭该假设的行为由独立回归测试检查；样本命令本身生成采用假设的阅读产物，并审计原始输入到该产物的变化。

样本报告应一起核对输入哈希、逐站点假设、剩余解码调用、仍有用途的辅助函数、未识别动态代码及关键业务调用。字符串调用清零表示已识别解码族的静态替换完成；它不表示网络契约已经证明、原始业务名称已经找回，或整个播放器在任意环境和输入下都等价。没有原始源码或原始 Source Map 时，变量名只能由用途证据或中性编号改善可读性。
