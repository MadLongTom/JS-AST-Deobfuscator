# 设计与边界

## 处理流程

`src/index.js` 负责选项校验、解析、pass 注册、迭代、代码生成及报告。每个 pass 暴露 `{ name, description, run(ast, context) }`，只处理自己的模式。每次 pass 前刷新 Babel 作用域绑定，避免前一个 pass 删除或替换节点后仍引用过期 binding。

`safe` 默认最多运行 5 轮，`readable` 默认 12 轮，显式 `maxIterations` 可覆盖。每轮对生成代码计算 SHA-256：与上一轮相同则收敛；与更早轮次相同则提示循环并停止；达到上限则提示 `MAX_ITERATIONS`。每个 pass 的返回值用于计数，实际代码指纹用于判断收敛。输出会再解析一次，及早报告损坏的 AST 或无效代码。

没有执行输入程序的模式。内置常量求值和字符串解码器使用受限的 AST 解释及本机实现的算法，未知表达式返回“无法确定”，由调用方保留原节点。字符串表解码设有操作、旋转和字符串长度限制，避免无边界的静态搜索。

直接数组解码器与自定义十六字符编码器使用严格结构匹配，既核对输出算法，也核对初始化、缓存、别名、逃逸和外部副作用。字符串表之间可分层处理；`inline-aliases` 只消除已初始化、不可变且不会捕获同名绑定的私有标识符别名。

`analyzeDynamicScope` 为各 pass 提供按绑定、插入位置及移动子树的风险查询；任意直接 eval 能影响其可见祖先绑定。JSON2 的受限 eval 通过完整固定语法验证识别，而非按函数名、文件名或验证码样本白名单放行；其中的计算属性必须先经无副作用的静态解码证明。显式内建方法修改、原型别名污染和未知逃逸会阻止这个证明。

`assumeDataEval: true` 是另一个显式的分析选项，仅允许 `profile: 'readable'`，默认 `false`，CLI 对应 `--assume-data-eval`。它按调用方承诺的数据解析契约分类旧式 eval 入口，包含 `eval('(' + input + ')')` 和独立语句 `eval('var name=' + input)`。分类不是输入内容证明，原 eval 和参数求值保留，未改为 `JSON.parse`。报告的 `assumptions` 逐站点记录原始位置、形态、引入的名字、数据契约及 `proven: false`，同时产生 `ASSUMED_DATA_EVAL` 诊断。未知 eval 和 with 始终保持动态屏障；没有该选项时仍只采用原有 JSON2 证明。

声明形态不能仅靠保留名字就完全免除动态作用域风险：例如 `eval('var d=' + input)` 可以引入或修改 `d`，并且影响范围是所在函数或脚本的变量环境，而非当前位置的词法块。动态作用域快照保留该名字对应的 binding 屏障，以及整个变量作用域内的 path/region 屏障，防止别名传播、删除声明或移动表达式绕过动态声明。它不再把数据表达式视为可以观察所有无关解码器名字。仅做纯字面替换的解码查询与一般路径/区域查询分开；后者不能因为前者允许替换字符串就放开代码移动。详见 [数据 eval 假设](data-eval.md)。

`renameBindings: true` 是仅适用于 readable 的独立最终阶段。它在迭代和可选 class 重建结束后执行，输出 `report.readability` 与名称映射。无原始源码或 Source Map 时，中性命名只能改善阅读；不会证明业务含义。函数名反射、词法捕获、公开绑定与动态作用域仍需检查。模块摘录由 `src/readability/webpack.js` 静态识别真实加载协议并建立依赖索引，不改变完整 bundle 的模块执行顺序。

## 可选的 class 最终阶段

`modernize: 'class'` 或 CLI `--modernize class` 显式启用 class 重建，默认 `modernize: false`。它在反混淆迭代结束后仅运行一次，不属于 `passes` 选择列表，也不因 `profile: 'readable'` 自动启用。`iterations` / `converged` 描述前面的反混淆迭代；最终输出指纹、Source Map 和 `residuals.after` 对应 class 阶段后的代码。

Lebab 3.2.9 仅对规范化后的候选构造函数/方法组执行 class 变换，不直接处理整份未知输入。Babel 负责作用域绑定分析、候选周边引用检查及转换结果重新放置。无法满足要求的候选保留，并在 `modernization.skipped` 中给出原因。输入程序从不被执行。

继承由独立的 Babel 模式阶段处理：只有识别完整的 ES5 桥接原型关系、稳定的父/子构造器别名、受支持的 `Parent.call(this, ...) || this` 返回捕获、安装时序和方法用途后，才恢复标准 `extends` / `super`。父构造器重赋值、提前观察、非预期返回值、`super` 初始化前读取 `this` 或未知包装调用等形态保留。对应转换记录标记 `engine: 'babel-inheritance'`，不把任意 `.call` 或整体 prototype 赋值机械替换为继承语法。

此阶段有明确的语言语义边界：转成 class 方法的成员不可枚举且不能充当构造器；class 构造器不能作为普通函数调用；class 主体处于严格模式。保留的运行时 prototype 函数赋值不改成普通 class 方法。函数声明提升与 class 的词法初始化不同，转换时必须处理构造器的引用时序和放置位置。候选静态检查无法证明来自外部脚本、反射或动态代码的所有使用方式，因此转换记录包含假设。输出用于阅读分析，不宣称任意旧式 prototype 程序与 class 结果完全等价，也不恢复原始名称。

`report.modernization` 仅在启用该阶段时提供，包含：

```js
{
  mode: 'class',
  tool,
  changes,
  classesConverted,
  prototypeMethodsConverted,
  staticMethodsConverted,
  durationMs,
  converted: [{ name, line, placementLine, methods, staticMethods, aliases, assumptions }],
  skipped: [{ name, line, reason }]
}
```

`totals.changes` 仍只累计反混淆 pass 的修改数，class 阶段另计 `totals.modernizationChanges`。修改次数与 class 数量含义不同，不应相加后当作还原百分比。

`npm run sample` 对原 fixture 分别生成普通 readable 版与 class 版，避免把已生成的 readable 文件当作新的输入而丢失原始 Source Map 关系。`artifacts/zhihuishu-2.classes.comparison.json` 比较两版的 class 声明/表达式、构造器、实例/静态方法和剩余 prototype 方法赋值数量，并附完整转换记录。`zhihuishu-2.class-preview.js` 是带完整文件行号的 class 分析摘录；周边闭包和初始化仍在完整文件中，摘录不能独立运行。

### prototype 覆盖审计

`zhihuishu-2.prototype-inventory.json` 对 readable 与 class 两版逐个记录 AST 的 `prototype` 成员访问，包括 `['prototype']` 写法。`totalTextOccurrences` 统计文本模式；`astPrototypeMemberAccesses` 统计语法节点，两者不能互相替代。每条记录包含所属库、构造器族/原始持有者、行列、分类及解释，并区分 `outside-class`、`class-static-block` 和其他 `class-body` 位置。可静态确定的构造器别名归到同一族；通用函数的构造器参数另列，避免与同名库 class 混合。

方法安装分为直接与运行时条件安装。共享原型数据赋值、整体原型替换、内建访问和动态读/调用另计；作为调用参数的 prototype 也可能用于描述符或继承，不能简单解释为纯读取。CryptoJS 的 `init.prototype`/委托对象模型保留其原语义。BigInteger 的浏览器环境选择不能在分析时固定到当前宿主，`DB` 等共享原型值也不能变成每实例字段。该样本的三种 `am` 函数安装及六项数据赋值明确保持在原位置，避免提前读取 `navigator` 或改变 `ot`、别名初始化与其他语句的相对时序。转换记录中的 `runtimeInstallationsRetained` 解释这类有意保留。

`coverage.directMethodInstallationReduction` 只衡量原来散落在类外的直接方法安装减少程度，类内 static 块仍会按实际语法记录 prototype 访问。它不是“所有原型操作的还原率”。新测试单独检查 BigInteger、reducers、RSA 父子 class 和指定方法集合，并要求类外残留大簇有明确的跳过原因。`zhihuishu-2.classes.comparison.json` 和 inventory 都保存 2.2.0 class 基线摘要，用于解释这次覆盖改进；旧生成文件在 `artifacts/v2.2.0/` 中保留。

当前固定快照生成 14 个 class，包含 152 个实例方法和 5 个静态方法；`x/I/P/q/L/O/nt/lt` 已纳入，`lt` 继承 `nt`。readable 版的 152 处直接 prototype 方法赋值降为 0。与旧 class 结果相比，AST prototype 访问从 139 降为 25，字面 `.prototype.` 从 126 降为 15。剩余 25 个节点包含 3 条运行时条件方法安装、9 条共享数据/元数据赋值、5 条动态整体替换和 8 条读/调用；不是 25 个未转换的方法。测试不锁死 class 总数，而核查指定族、实际方法、运行时分支和类外残留直接安装的覆盖。

除 `pt`/JSEncrypt 外，样本还生成 `O`/BigInteger 与 `nt` + `lt extends nt`/RSA 的完整 class 摘录。BigInteger 摘录额外附原环境选择和共享数据设置的完整语句，每一段都标注原位行号；并排排列不意味着可以把这些运行时语句移到 class 后立刻执行。所有摘录保留实际名称，并依赖周围闭包，不能独立运行。

## safe 与 readable 的假设

`safe` 是默认配置，重点是可证明的局部静态变换。源码字符串已经变化，依赖函数源码、自修改、防调试、宿主环境和外部内建对象修改的代码仍可能受到影响；名称“safe”不表示任意程序的等价保证。

`readable` 显式优先人工分析。它可以中和已识别的源码自检，并在无剩余业务用途时清理混淆器辅助族。中和自检是有意的行为改变，必须在诊断中披露。该配置不会执行输入，不把未知 helper 当普通无用函数删除，也不重命名为猜测的原始业务标识符。字符串、函数名和控制流的可读性改善不能替代对真实业务的验证。

单独选择 `readable` 不会启用 `assumeDataEval`。显式启用后，假设的数据字面量只包含字符串、数字、布尔值、null、数组和对象属性值；不包含名字读取、调用、函数、访问器、计算属性、展开、赋值或额外语句。工具不读取真实响应来证明这个契约，而是在报告中保留它。对手写受信的测试数据可做有限语义对照；不能据此声称超星等真实样本的任意输入都等价。

语句规范化只在适当的语句位置展开逗号、条件和逻辑表达式；不把短路操作的副作用提前，不拆分循环头，也不改变调用目标的值/引用类别。展开后的字符串表达式不能意外变成 `use strict` 指令。复杂 dispatch case 中的作用域、声明提升、跳转目标仍是控制流还原必须检查的条件。

## 保留语义的规则

- 使用 Babel binding 识别标识符，区分同名参数、局部变量、helper 和全局函数。
- 内联前检查修改、声明位置和作用域；不能把初始化后的值传播到 TDZ 或 `var` 初始化之前。
- 包装函数只改写受支持的参数表达式与调用代理。动态实参按顺序恰好求值一次；遇到重排、重复或短路时使用局部临时绑定，保持 `this`、`arguments`、间接 eval 和异常时序。
- 对象存在写入、别名逃逸或 getter 等情况时，保留无法证明的属性访问。
- 清理不可达分支时考虑 `var` 提升、块作用域和 Annex B 函数声明；删除未引用声明时保留有作用的初始化器。
- `safe` 下，经典 script 的顶层绑定可能供其他脚本、HTML 事件处理器或外部调用使用，不因本文件内缺少引用就删除。`readable` 清理已识别的混淆器辅助族时采用额外的私有性假设并记录诊断；ES module 的导出始终保留。
- 检测到直接 `eval` 等动态作用域行为时，对涉及绑定的优化采取保守策略。条件表达式或逻辑表达式作为调用目标时，保留“值”与“引用”的区别，避免改变接收者或把间接 eval 变成直接 eval。

这些规则覆盖受支持的常见模式，不能证明任意 JavaScript 程序等价。代理、外部脚本修改内建对象、源码自检、运行时生成代码、依赖函数 `toString()` 的反调试等会超出普通 AST 改写的能力。格式和源码文本本身会变化。未知混淆形态应新增最小样例和回归测试后再扩展模式。

## API 与错误

`deobfuscate(source, options)` 同步返回 `{ code, map, report }`，未启用 Source Map 时 `map` 为 `null`。`listPasses()` 返回默认顺序中的 `{ name, description }`。`sourceType: 'unambiguous'` 让 Babel 按 import/export 推断模块；需要强制经典脚本或模块语义时显式指定。

错误对象使用 `DeobfuscationError`，包括稳定的 `code`：

| code | 含义 |
| --- | --- |
| `INVALID_OPTIONS` | 参数、选项、pass 名称或注册信息无效 |
| `PARSE_ERROR` | 输入解析失败，包含 `location` |
| `PASS_ERROR` | pass 异常、返回值不合法或生成代码无法解析；可用时包含 `passName` / `location` |

报告 `schemaVersion: 1`，结构如下：

```js
{
  schemaVersion: 1,
  profile: 'safe',
  input: { filename, bytes, sha256 },
  output: { bytes, sha256 },
  iterations,
  converged,
  passes: [{ name, iteration, changes, durationMs }],
  totals: { changes, durationMs },
  diagnostics: [{ level: 'warning', code, message, details /* 可选 */ }],
  assumptions: [{ kind, location, proven: false, introducedNames, assumptions }],
  residuals: { before: metrics, after: metrics }
}
```

API 报告中的输出指纹对应返回的 `code`。CLI 在添加 Source Map 注释后重新计算指纹，其报告对应最终输出字节。耗时由实际运行测量，不能作为跨机器快照断言。

`assumptions` 是显式假设的逐站点记录，未采用数据 eval 假设时为空数组。`location` 指向原输入的行号和零起算列号，`input.sha256` 绑定对应的源码字节。Source Map 继续指向最初输入，而非先前生成的 readable 文件；样本对照需从同一原始文件分别生成结果。诊断或残留数量与假设数量不是同一个指标。

残留指标包括 `nodes`、`obfuscatedBindings`、`obfuscatedAliasDeclarations`、`dispatcherLoops`、`proxyFunctionCandidates`、`sequenceExpressions`、`conditionalExpressions` 和 `sourceSelfDefensePatterns`。这些是按 AST 模式统计的候选数量：业务代码也可能符合代理或命名模式，单个计数下降不构成正确性证明。样本比较还应检查具体业务分支、公开导出以及保留的密码算法和通信调用。

## 测试与扩展

测试采用 Node 内置 `node:test`。API 和 CLI 测试覆盖输入输出、Source Map、配置优先级、错误和报告；手写短程序在独立 VM context 中比较结果、作用轨迹及异常类型。真实网站 fixture 仅检查来源指纹、静态转换和重新解析，绝不送进 VM。

增加 pass 时先加入确定可处理的正向样例，再加入模式相近但不应处理的反例。任何变换都应记录实际修改数，遇到未知行为时保留节点；不要为了提高数字而执行源代码或扩大假设。自定义 pass 在宿主 Node 进程中运行，不具有隔离或权限边界。

数据 eval 回归还应分别检查默认兼容、逐站点选择、同作用域的未知 eval、with、被遮蔽的 eval 名字、声明形态的引入名字和整个变量环境屏障，以及纯字面解码与一般路径变换的区别。超星样本脚本 `scripts/chaoxing-sample.cjs` 由 `npm run sample:chaoxing` 调用，只进行源码指纹检查、静态变换、重新解析和指标审计，不运行播放器、不登录站点、不发送学习记录。

CI 在 Linux 和 Windows 的 Node.js 20、22、24 上执行 `npm ci`、`npm run lint`、`npm test`。`lint` 是项目的语法和静态约束检查，不自动改写代码。
