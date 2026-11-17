# JS-AST-Deobfuscator

基于 Babel 的 JavaScript 静态反混淆工具。解析源码、按作用域执行多轮 AST 变换，再生成可读代码、Source Map 和 JSON 报告。输入代码不会被 `eval`、`Function` 或 `vm` 执行。

需要 **Node.js 20.19+**。在仓库目录安装和检查：

```sh
npm ci
npm run lint
npm test
```

## 命令行

```sh
node bin/js-ast-deobfuscator.js input.js -o safe.js --report safe.report.json --source-map
node bin/js-ast-deobfuscator.js input.js --profile readable -o readable.js --report readable.report.json
node bin/js-ast-deobfuscator.js input.js --profile readable --rename -o named.js --report named.report.json
node bin/js-ast-deobfuscator.js input.js --profile readable --assume-data-eval --rename -o data-readable.js --report data-readable.report.json --source-map
node bin/js-ast-deobfuscator.js input.js --profile readable --modernize class -o classes.js --report classes.report.json
node bin/js-ast-deobfuscator.js input.js --passes normalize-literals,constant-fold --max-iterations 3
node bin/js-ast-deobfuscator.js --list-passes
node bin/js-ast-deobfuscator.js --help
```

输入路径为 `-` 时从标准输入读取；未指定 `-o` 时，标准输出只包含生成代码，诊断写入标准错误。安装为 npm 包后也可使用 `js-ast-deobfuscator` 命令。

| 选项 | 含义 |
| --- | --- |
| `-o, --output <path>` | 输出代码文件 |
| `--report <path>` | 保存 JSON 变换报告 |
| `--source-map` | 写入 `<输出文件>.map` 并追加 `sourceMappingURL`；需要 `-o` |
| `--passes <names>` | 逗号分隔的 pass 名称；严格按指定顺序执行 |
| `--profile <name>` | `safe`（默认）或 `readable` |
| `--modernize class` | 显式启用最终 class 重建阶段；默认关闭 |
| `--rename` | 在 `readable` 的最终阶段给私有绑定分配有证据的名称或中性编号，并记录映射 |
| `--assume-data-eval` | 显式假设已识别的旧式 `eval` 数据入口只接收数据字面量；仅适用于 `readable`，默认关闭 |
| `--max-iterations <n>` | 迭代上限，整数 1–50；`safe` 默认 5，`readable` 默认 12 |
| `--source-type <type>` | `unambiguous`（默认）、`script` 或 `module` |
| `--config <path>` | 加载 JSON 配置；命令行选项覆盖同名配置 |
| `--list-passes` | 列出内置 pass |
| `--help` / `--version` | 显示帮助或版本 |

配置示例：

```json
{
  "passes": ["normalize-literals", "decode-string-arrays", "constant-fold"],
  "maxIterations": 5,
  "profile": "safe",
  "sourceType": "unambiguous"
}
```

未知参数、未知 pass、配置错误或语法错误会返回非零退出码。

## JavaScript API

```js
const { deobfuscate, listPasses } = require('js-ast-deobfuscator');

const { code, map, report } = deobfuscate(source, {
  filename: 'input.js',
  sourceType: 'unambiguous',
  sourceMaps: true,
  profile: 'safe',
  maxIterations: 5,
});

console.log(listPasses());
```

在仓库内使用 `require('./src/index.js')`。`passes: []` 关闭迭代 pass；未启用 `modernize` 或 `renameBindings` 时只解析和重新打印。`plugins` 选项接受 Babel parser 的插件数组，默认启用 `jsx`；这不会执行 TypeScript 编译或 JSX 转译。

API 和 JSON 配置还可设置静态解码上限：`maxDecoderOperations`（默认 2000000，范围 1000–10000000）、`maxStringArrayRotations`（默认 10000，范围 1–100000）、`maxDecodedStringLength`（默认 100000，范围 1024–1000000）。超出处理范围的调用保留；操作预算耗尽或旋转无法求解时记录诊断。

## 两种处理配置

`safe` 使用保守的静态变换，保留未证明可删除的脚本顶层绑定和源码自检代码。它适合先观察字符串解码、常量以及可证明的控制流和语句简化结果。格式变化本身仍可能触发依赖函数 `toString()` 的自检，因此它也不等同于运行时等价证明。

`readable` 适合人工审阅：在局部语句和控制流变换之外，可清理符合条件的混淆器辅助族，并明确中和已识别的源码自检。该配置允许改变这些防护代码的行为；相关动作会记录在报告诊断中。它不会执行输入，也不会恢复原始变量名。真实样本的输出应作为分析材料，不能直接视为可替换线上脚本的产物。

显式 `passes` 始终按给定列表执行。选择 `readable` 并不让工具任意删除动态逻辑，无法证明或未识别的形态仍需保留并检查报告。

## 分层字符串解码与可读命名

字符串表支持函数 provider 和直接声明的数组，包括自定义 Base64 字母表、严格识别的局部缓存、偏移索引，以及嵌套的十六字符替换编码。解码使用工具自身的实现，不执行输入 helper。不可变私有数组的静态自有元素索引可以继续还原；存在写入、逃逸、未知返回变换或可观察的缓存用途时保留原代码。

动态作用域按绑定及变换位置检查。无关模块中的 `eval` 不再让整个文件停止优化；可见祖先绑定、`with` 和未知动态代码仍受保护。对 JSON2 兼容解析器，仅在匹配完整固定正则链、字符串强制转换、规范转义及无污染内建方法时，才能证明该处 `eval` 只求值 JSON 数据表达式。原解析器和 `eval` 保留在输出中。

旧式播放器有时直接使用 `eval('(' + response.responseText + ')')` 或独立语句 `eval('var data=' + text)` 解析数据，没有 JSON2 的完整校验链。若调用方已核实这些入口的数据契约，可显式设置 `assumeDataEval: true`（CLI `--assume-data-eval`），与 `profile: 'readable'` 一起使用。工具只按已识别形状采用这个契约假设，不会证明网络响应安全，不执行输入，也不把原调用替换成 `JSON.parse`。

括号表达式与单变量 `var` 声明分别处理。`var d`、`var data`、`var subs` 等形态仍会引入或修改名字：对应绑定、整个变量作用域内的路径和移动区域继续受保护；静态字符串解码使用单独的纯字面替换检查，避免为了解码而放开任意代码移动。未知 `eval` 和 `with` 不受该选项豁免。逐站点的原始位置、`introducedNames` 和 `proven: false` 写入 `report.assumptions`，并产生 `ASSUMED_DATA_EVAL` 诊断。默认模式与 JSON2 的自动证明规则保持不变。详细形状、限制和使用示例见 [数据 eval 假设](docs/data-eval.md)。

`renameBindings: true`（CLI `--rename`）仅适用于 `readable`，在解码和可选 class 阶段之后执行一次。它按真实 Webpack 调用协议识别 `module`、`exports`、`require` 参数，按静态属性用途推导名称；没有证据时使用中性编号。会影响函数或类名称、动态作用域或公开可见性的绑定保留。`report.readability` 包含名称映射、命名理由和保留原因；中性编号不代表恢复了原始业务名。

已识别的 Webpack bundle 可以拆成阅读摘录：

```sh
node scripts/extract-modules.cjs named.js artifacts/modules
```

`index.json` 记录入口、模块编号、静态依赖和完整 bundle 行号。各 factory 摘录依赖原闭包，仅供阅读，不能独立执行。

仓库固定了一份易盾 `2.28.5` 静态回归样本，来源、时间及 SHA-256 见 `test/fixtures/netease-core-2.28.5.metadata.json`。运行 `npm run sample:yidun` 可在 `artifacts/yidun-core-2.28.5/` 重现完整输出、Source Map、变换报告、前后指标和模块阅读摘录。真实 SDK 不参与运行时测试，也不发起验证码请求。

## 可选 class 重建

```js
const result = deobfuscate(source, {
  profile: 'readable',
  modernize: 'class',
  sourceMaps: true,
  filename: 'input.js',
});
console.log(result.report.modernization);
```

`modernize` 默认是 `false`，选择 `readable` 也不会自动启用它。启用 `'class'` 后，工具先完成反混淆，再把符合条件的构造函数与 prototype/静态方法整理为 class。Lebab **3.2.9** 只处理经规范化和筛选的候选；Babel 负责绑定检查及放置转换结果。此过程不执行输入代码，也不猜测或恢复原始类名。

已识别的 ES5 桥接继承由专门的 Babel 阶段恢复 `extends` / `super`，检查别名稳定性、引用时序和父构造器返回值；未知或不满足条件的动态继承保留原形式。继承转换记录带有 `engine: 'babel-inheritance'`。

这是用于阅读的显式变换，存在 class 语法固有的行为差异：转成 class 方法的成员变为不可枚举且不能用 `new` 调用，构造器必须通过 `new` 调用，class 主体采用严格模式；函数声明提升与 class 的词法初始化也不同。保留的运行时 prototype 函数安装仍使用原来的赋值形式。工具检查可识别的用法并跳过不满足条件的候选，仍需阅读转换记录中的假设与 `skipped[].reason`，不能把转换数量理解为等价证明。

报告中的 `modernization` 包括 `classesConverted`、`prototypeMethodsConverted`、`staticMethodsConverted`、`converted` 和 `skipped`。`converted` 记录名称、原始位置、放置位置、方法数、别名和假设；`skipped` 记录保留的构造函数及原因。反混淆计数仍在 `totals.changes`，class 阶段单独计入 `totals.modernizationChanges`。

主要 pass：

| pass | 主要能力 |
| --- | --- |
| `normalize-literals` | 规范数字、字符串和合法的计算属性写法 |
| `decode-string-arrays` | 静态识别字符串表、索引偏移、别名、部分 Base64/RC4 解码和旋转表 |
| `constant-fold` | 折叠可证明的 primitive 常量表达式 |
| `inline-constants` | 内联已初始化且不变的私有常量 |
| `inline-objects` | 简化无写入、无逃逸的私有对象属性和简单分发表 |
| `inline-wrappers` | 展开参数表达式和调用代理，保留动态实参的求值顺序、次数与接收者语义 |
| `control-flow` | 还原受限的字符串顺序表 + `while/switch` 调度器 |
| `dead-code` | 清理可证明的不可达代码和无用私有声明，保留作用与声明提升 |
| `normalize-statements` | 把逗号语句、语句中的条件/逻辑表达式等展开为易读的独立语句 |
| `cleanup-decoders` | 清理已无外部用途的已识别字符串表、解码器、别名和旋转初始化器 |
| `neutralize-self-defense` | 在 `readable` 配置下中和已识别的源码自检，记录有意行为变化 |

变换采用保守策略：不确定的动态索引、绑定修改、TDZ、对象逃逸、getter、复杂控制流等通常保留。不会恢复原始变量名，也不保证完整还原任意混淆器。输出仍需结合原业务验证。详见 [设计和限制](docs/design.md)。

## 扩展 pass

```js
const result = deobfuscate(source, {
  passes: ['constant-fold', 'my-pass'],
  customPasses: [{
    name: 'my-pass',
    description: '说明此变换的用途',
    run(ast, context) {
      // 使用 Babel AST；变更节点后返回实际修改次数。
      // context.warn('MY_WARNING', '无法静态确定时保留原代码');
      return 0;
    },
  }],
});
```

`run` 必须同步返回非负整数。未指定 `passes` 时，自定义 pass 追加到默认管线；显式指定时，只运行列表中的 pass。名称需唯一并采用小写连字符格式。`context.options` 提供规范化选项，`context.warn(code, message, details?)` 将警告写入报告。自定义 pass 是本机受信任代码，应自行遵守静态处理原则；JSON 配置不加载可执行插件。

## 报告和真实样本

报告包含 `profile`、输入/输出的 UTF-8 字节数及 SHA-256、每轮每个 pass 的修改数和耗时、收敛状态及诊断。`residuals.before` / `residuals.after` 比较 AST 节点、混淆命名绑定、别名、调度循环、代理函数候选、逗号/条件表达式和源码自检特征的数量。达到迭代上限或检测到循环时停止并报告。`changes` 和残留计数是静态分析指标，不代表还原比例。

超星播放器样本的复现入口为 `npm run sample:chaoxing`，对应 `scripts/chaoxing-sample.cjs`。它从仓库内固定的原始视频入口和 Video.js 扩展生成显式数据 eval 假设下的 readable 产物，默认写到 `artifacts/chaoxing/`，包括完整代码、Source Map、报告及转换前后残留审计。运行方法和样本来源见 [超星样本复现](docs/data-eval.md#超星样本复现)。输出用于代码审阅；字符串调用清零、重新解析通过或指标下降都不构成全程序等价证明，也不表示恢复了原始名称。

```sh
npm run sample
```

该命令静态处理 `test/fixtures/zhihuishu-2.obfuscated.js`，在 `artifacts/` 写出 `zhihuishu-2.readable.js`、对应 Source Map 和 `.readable.report.json`；`zhihuishu-2.comparison.json` 依据固定基线摘要对比新结果的静态指标。基线摘要保存在 [baseline 元数据](test/fixtures/zhihuishu-2.baseline.json)。样本来自智慧树网站的 `2.js` 快照，来源、抓取日期和 SHA-256 记录于 [fixture 元数据](test/fixtures/zhihuishu-2.metadata.json)。测试只转换和重新解析该文件，**不会执行它**。语义对比测试中的 `node:vm` 仅运行仓库内手写的受信任短程序。

同时生成 `zhihuishu-2.business.js` 与 `zhihuishu-2.libraries.js`：按已识别的 UMD 结构分开业务定义与 CryptoJS/JSEncrypt，便于人工阅读。这两份是分析摘录，保留原文件执行顺序的完整产物是 `.readable.js`；摘录不是独立可运行模块。原样本命令使用的 `zhihuishu-2.js` 和 `.report.json` 路径也会更新。

样本命令还会从同一原始 fixture 独立启用 class 重建，新增 `zhihuishu-2.classes.js`、`.classes.js.map`、`.classes.report.json` 和 `.classes.comparison.json`，并保留前述输出。class 版 Source Map 指向原 fixture。`zhihuishu-2.class-preview.js` 摘出完整的 `pt`/JSEncrypt class，保留实际名称，并标注它在完整 class 文件中的行号；该摘录依赖外层闭包，**不能独立运行**。比较报告列出 class/方法语法数量、剩余 prototype 赋值，以及转换和跳过记录。

另有 `zhihuishu-2.big-integer-preview.js` 与 `zhihuishu-2.rsa-preview.js`。前者展示完整的 `O`/BigInteger class，并附环境选择 `am` 和六项共享原型数据的完整原位初始化语句；后者同时展示 `nt` 父类与 `lt extends nt` 子类。同样保留原名称、完整文件位置和非独立运行说明。BigInteger 摘录中把分散的段落并排展示只为阅读，不能据此把运行时初始化提前到 class 声明之后。

`zhihuishu-2.prototype-inventory.json` 全量盘点 readable 与 class 两版的 prototype 用法：文本出现次数、AST 成员访问、直接/条件方法安装、共享原型数据写入、整体原型替换、内建或动态读/调用，并按构造器族列出数量与行号。类内 `static` 块与类外位置分别计数。此样本的 `am` 三分支和六项数据保持原初始化位置，通过 `runtimeInstallationsRetained` 等记录解释保留原因，避免改变 `navigator`、`ot` 和别名 `A` 的时序。它也对照固定的 [2.2.0 class 基线](test/fixtures/zhihuishu-2.classes-baseline.json)；旧输出保留在 `artifacts/v2.2.0/`。

prototype 访问本身不等于混淆。BigInteger 的环境选择方法和共享常量、CryptoJS 的委托对象模型、通用继承/描述符操作及 `Object.prototype` 调用都有语义用途；这些应保留或在 class 内集中表达。覆盖率针对可合并的直接方法安装，不以消除所有 `.prototype` 文本为目标。

当前固定样本的 class 覆盖对比：

| 指标 | 2.2.0 class 基线 | 当前 class 结果 |
| --- | ---: | ---: |
| 生成 class | 6 | 14 |
| 转为 class 的原型方法 | 41 | 152 |
| 转为 class 的静态方法 | 2 | 5 |
| 类外 prototype 函数赋值 | 114 | 3（运行时 `am` 选择） |
| AST prototype 成员访问 | 139 | 25 |
| 字面文本 `.prototype.` | 126 | 15 |

readable 版中的 152 处直接方法安装已全部集中到 class。余下 25 处 AST 访问分类为 3 处条件函数安装、9 处数据赋值、5 处整体原型替换和 8 处读/调用，均可在 inventory 中逐条定位；没有未解释的直接方法安装大簇。`x/I/P/q/L/O/nt/lt` 已覆盖，其中 `lt extends nt`；BigInteger 的三种 `am` 实现和共享数据仍按原环境与时序初始化。

真实样本测试还要求至少解析 1200 处字符串调用，并检查关键 URL 和 `aesUtil.encrypt` 可读访问，防止仅重新排版也被误判为成功。这些是静态回归指标，不证明真实网站样本的运行时行为完全等价。

当前固定快照的静态比较：旧结果中的 3 个调度循环降为 0，代理函数候选从 309 降为 4，混淆命名别名声明从 197 降为 9，混淆命名绑定从 1525 降为 365。测试还检查 `labc` 的 AJAX 参数和 Promise 回调直调、伪分支移除，以及 `yxyz` 返回 `aesUtil.encrypt`。余下 4 个候选位于 JSEncrypt，分别返回 `t & e`、`t | e`、`t ^ e`、`t & ~e`，是库的位运算辅助函数，保留其函数值用途。数字代表模式匹配结果，不代表未还原的业务功能数量。

## 旧版本和许可

2.x 使用统一的 `deobfuscate()` / CLI 接口。原 `main.js`、`visitor.js` 保存在 `legacy/`，旧输入输出保存在 `examples/legacy/`，供历史参考；旧 visitor API 不属于新运行入口。仓库根目录 `main.js` 是新 CLI 的兼容启动入口。

项目沿用 [MadLongTom/JS-AST-Deobfuscator](https://github.com/MadLongTom/JS-AST-Deobfuscator) 的 MIT 许可，保留 `Copyright (c) 2024 MadLongTom`，见 [LICENSE](LICENSE)。第三方网站样本及其内嵌库保留原权利和许可声明，不因收录为测试 fixture 而改为本项目的 MIT 许可。
