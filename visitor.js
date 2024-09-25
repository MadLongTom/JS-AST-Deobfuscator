
const parser = require("@babel/parser");
const types = require("@babel/types");
const traverse = require("@babel/traverse").default;
const babel = require('@babel/core');

function fixReference(path) {
    function _fixReference(identifierPath) {
        const binding = path.scope.getBinding(identifierPath.node.name);
        if (binding === undefined) return;
        if (binding.referencePaths.indexOf(identifierPath) !== -1) return;
        binding.referencePaths.push(identifierPath);
        binding.references = binding.referencePaths.length;
        binding.referenced = binding.references !== 0;
    }
    //traverse不会遍历自己
    if (path.node.type === "Identifier") {
        _fixReference(path);
    } else {
        path.traverse({
            Identifier(identifierPath) {
                _fixReference(identifierPath);
            }
        })
    }
}

function removeReference(path) {
    function _removeReference(identifierPath) {
        const binding = path.scope.getBinding(identifierPath.node.name);
        if (binding === undefined) return;
        const idx = binding.referencePaths.indexOf(identifierPath);
        if (idx > -1) {
            binding.referencePaths.splice(idx, 1);
            binding.references = binding.referencePaths.length;
            binding.referenced = binding.references !== 0;
        }
    }
    //traverse不会遍历自己
    if (path.node.type === "Identifier") {
        _removeReference(path);
    } else {
        path.traverse({
            Identifier(identifierPath) {
                _removeReference(identifierPath);
            }
        })
    }
}

function replaceWith(path, node) {
    function tryUnwarpBlockStatement(node) {
        if (node.type !== "BlockStatement" || node.body.length !== 1) return node;
        else return node.body[0];
    }
    removeReference(path);
    path.replaceWith(tryUnwarpBlockStatement(node));
    fixReference(path);
}

const stringDecodeVisitor = {
    StringLiteral(path) {
        delete path.node.extra
    }
}

function hasSingleStatement(funcNode) {
    return funcNode.body.type === 'BlockStatement' && funcNode.body.body.length === 1 && funcNode.body.body[0].type === "ReturnStatement";
}

function isRecursionFunction(funcPath) {
    // 他如果还能通过别的方式递归那我也没法了
    if (funcPath.node.id === null) return false;
    let ret = false;
    funcPath.traverse({
        enter(path) {
            if (funcPath.parentPath.scope.bindings[funcPath.node.id.name].referencePaths.some(function (refPath) { return refPath.node === path.node; })) {
                ret = true;
                path.stop();
            }
        }
    })
    return ret;
}

function inlineFunction(func, call) {
    const arg = call.node.arguments;
    // functionExpression
    // params: Array<Identifier | Pattern | RestElement> (required)
    func.node.params.forEach(function (param, idx) {
        let paramName;
        if (types.isIdentifier(param)) {
            paramName = param.name;
        } else if (types.isPattern(param)) {
            if (param.left.type !== "Identifier") throw new Error('unknown node type');
            paramName = param.left.name;
        } else if (types.isRestElement(param)) {
            if (param.argument.type !== "Identifier") throw new Error('unknown node type');
            paramName = param.argument.name;
        }
        func.scope.bindings[paramName].referencePaths.slice().forEach(function (path) {
            if (path.node.type === "Identifier") {
                // node未修改完 replace的时候没有正确的scope 因此需要在最后修复reference
                if (types.isIdentifier(param)) {
                    removeReference(path);
                    path.replaceWith((arg[idx] === undefined ? types.identifier("undefined") : types.cloneDeepWithoutLoc(arg[idx])));
                } else if (types.isPattern(param)) {
                    removeReference(path);
                    path.replaceWith(types.cloneDeepWithoutLoc((arg[idx] === undefined || arg[idx].value === undefined) ? param.right : arg[idx]));
                } else if (types.isRestElement(param)) {
                    removeReference(path);
                    path.replaceWith(types.arrayExpression(arg.slice(idx)));
                }
            } else {
                throw new Error('unknown node type');
            }
        })
    })
    replaceWith(call, types.cloneDeepWithoutLoc(func.node.body.body[0].argument));
}
function inlineNamedFunction(path) {
    // 没考虑通过arguments访问参数的情况
    const node = path.node
    if (!hasSingleStatement(node)) return;
    if (node.generator || node.async) return;
    if (isRecursionFunction(path)) return;
    if (node.id !== null) {
        const name = node.id.name;
        const binding = path.scope.parent.bindings[name];
        _referencePaths = []
        binding.referencePaths.slice().forEach(function (nodePath) {
            if (nodePath.parent.type === "CallExpression") {
                _node = types.cloneDeepWithoutLoc(node);
                nodePath.replaceWith(types.functionExpression(null, _node.params, _node.body, _node.generator, _node.async));
                inlineFunction(nodePath, nodePath.parentPath);
            } else {
                _referencePaths.push(nodePath);
            }
        });
        binding.referencePaths = _referencePaths;
        binding.references = _referencePaths.length;
        binding.referenced = binding.references !== 0;
    }
}

/*
这个 `inlineFunctionDeclarationVisitor` 函数处理的是那些定义了函数但没有被引用的函数声明。
如果一个函数声明的标识符在其父作用域中没有被引用，那么这个函数声明就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
function add(x, y) {
    return x + y;
}

function subtract(x, y) {
    return x - y;
}

let result = add(1, 2);
```

在这个例子中，`function add(x, y) { return x + y; }` 和 `function subtract(x, y) { return x - y; }` 是函数声明，它们的标识符分别是 `add` 和 `subtract`。`add` 在其父作用域中被引用，
因此 `function add(x, y) { return x + y; }` 不会被处理。`subtract` 在其父作用域中没有被引用，因此 `function subtract(x, y) { return x - y; }` 会被处理。
因此，`inlineFunctionDeclarationVisitor` 函数会移除 `function subtract(x, y) { return x - y; }`，如下所示：

```javascript
function add(x, y) {
    return x + y;
}

let result = add(1, 2);
```

注意，`function subtract(x, y) { return x - y; }` 被移除了。
 */
const inlineFunctionDeclarationVisitor = {
    FunctionDeclaration(path) {
        if (path.node.id) inlineNamedFunction(path);
        if (!(path.node.id && path.scope.parent.bindings[path.node.id.name].referenced)) {
            removeReference(path);
            path.remove();
        }
    }
}

/*
这个 `inlineLiteralVisitor` 函数处理的是那些包含特定字面量的代码块。如果一个变量声明的初始化表达式是一个字符串字面量、数字字面量或布尔字面量，并且这个变量声明不在循环体内，那么这个变量声明就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let str = "Hello, world!";
let num = 42;
let bool = true;

console.log(str);
console.log(num);
console.log(bool);
```

在这个例子中，`let str = "Hello, world!";`、`let num = 42;` 和 `let bool = true;` 是变量声明，它们的初始化表达式分别是一个字符串字面量 `"Hello, world!"`、一个数字字面量 `42` 和一个布尔字面量 `true`，并且这些变量声明不在循环体内，因此这些变量声明会被处理。因此，`inlineLiteralVisitor` 函数会将这些变量声明替换为它们的值，如下所示：

```javascript
console.log("Hello, world!");
console.log(42);
console.log(true);
```

注意，`str` 被替换为它的值 `"Hello, world!"`，`num` 被替换为它的值 `42`，`bool` 被替换为它的值 `true`。
 */
function inlineLiteralVisitor(ast) {
    traverse(ast, {
        VariableDeclarator(path) {
            // 检查是否在循环体内
            let parentPath = path.parentPath;
            while (parentPath) {
                if (types.isLoop(parentPath)) {
                    return;
                }
                parentPath = parentPath.parentPath;
            }

            let replacements = {};
            if (types.isStringLiteral(path.node.init) ||
                types.isNumericLiteral(path.node.init) ||
                types.isBooleanLiteral(path.node.init)) {
                replacements[path.node.id.name] = path.node.init.value;
            }

            path.scope.traverse(path.scope.block, {
                MemberExpression(innerPath) {
                    if (!innerPath.parentPath.isAssignmentExpression({ left: innerPath.node }) &&
                        types.isIdentifier(innerPath.node.property) &&
                        replacements.hasOwnProperty(innerPath.node.property.name)) {
                        console.log("inlineLiteralVisitor:replace:" + innerPath.node.property.name)
                        innerPath.replaceWith(types.valueToNode(replacements[innerPath.node.property.name]));
                    }
                }
            });
        }
    });
}

/*
这个 `functionEvalVisitor` 函数处理的是那些调用特定函数的代码块。
如果一个函数调用的调用者是一个标识符，并且这个标识符的名称与给定的函数名称相同，那么这个函数调用就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
function add(x, y) {
    return x + y;
}

let result = add(1, 2);
```

在这个例子中，`add(1, 2)` 是一个函数调用，它的调用者是一个标识符 `add`，这个标识符的名称与给定的函数名称 `add` 相同，因此这个函数调用会被处理。
因此，`functionEvalVisitor` 函数会将这个函数调用替换为它的返回值，如下所示：

```javascript
function add(x, y) {
    return x + y;
}

let result = 3;
```

注意，`add(1, 2)` 被替换为它的返回值 `3`。
 */
function functionEvalVisitor(funcName, func) {
    return {
        CallExpression(path) {
            if (path.node.callee.type === "Identifier" && path.node.callee.name === funcName) {
                removeReference(path);
                const evaluate = path.get("arguments").map((path) => { return path.evaluate() });
                if (evaluate.every((eval) => { return eval.confident })) {
                    const args = evaluate.map((eval) => { return eval.value });
                    const value = func(...args);
                    switch (typeof value) {
                        case "string":
                            path.replaceInline(types.stringLiteral(value));
                            break;
                        case "number":
                            path.replaceInline(types.numericLiteral(value));
                            break;
                        case "boolean":
                            path.replaceInline(types.booleanLiteral(value));
                            break;
                        case "undefined":
                            path.replaceInline(types.identifier('undefined'));
                            break;
                        case "object":
                            if (value === null) {
                                path.replaceInline(types.nullLiteral());
                            }
                            else if (Array.isArray(value)) {
                                path.replaceInline(types.arrayExpression(value.map((item) => {
                                    return types.valueToNode(item);
                                }
                                )));
                            } else {
                                path.replaceInline(types.objectExpression(Object.entries(value).map(([key, value]) => {
                                    return types.objectProperty(types.stringLiteral(key), types.valueToNode(value));
                                })));
                            }
                            break;
                        default:
                            throw new Error("Unsupported return type " + typeof value);
                    }
                }
            }
        }
    }
}

/*
这个 `DispatcherMatchExpressionVisitor` 函数处理的是那些包含特定表达式的抽象语法树（AST）。
如果一个变量声明的初始化表达式与给定的目标表达式相同，那么这个变量声明就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let targetFunction = function() {
    console.log("This is the target function.");
};

let nonTargetFunction = function() {
    console.log("This is not the target function.");
};
```

在这个例子中，`let targetFunction = function() { console.log("This is the target function."); };` 是一个变量声明，它的初始化表达式 `function() { console.log("This is the target function."); }` 与给定的目标表达式相同，因此这个变量声明会被处理。
`let nonTargetFunction = function() { console.log("This is not the target function."); };` 是另一个变量声明，它的初始化表达式 `function() { console.log("This is not the target function."); }` 与给定的目标表达式不同，因此这个变量声明不会被处理。

如果我们将 `function() { console.log("This is the target function."); }` 作为目标表达式传递给 `DispatcherMatchExpressionVisitor` 函数，那么它会返回一个包含 `targetFunction` 的数组，如下所示：

```javascript
["targetFunction"]
```

注意，`DispatcherMatchExpressionVisitor` 函数会遍历抽象语法树（AST），找到所有初始化表达式与给定的目标表达式相同的变量声明，然后返回这些变量声明的标识符名称。
 */
function DispatcherMatchExpressionVisitor(ast, expr) {
    let targetAst = parser.parse(expr).program.body[0].expression;
    let funcname = [];
    traverse(ast, {
        VariableDeclarator(path) {
            const initCode = generate(path.node.init).code;
            if (initCode === targetCode) {
                funcname.push(path.node.id.name);
            }
        }
    });
    return funcname;
}
/*
function DFSDispatcherMatchVisitor(ast, dispatcherName, func, scope = null) {
    let funcname = DispatcherMatchVisitor(ast, dispatcherName)
    funcname.forEach(
        (name) => {
            require('@babel/traverse').default(ast, {
                FunctionDeclaration(path) {
                    if (scope === null || path.node.id.name === scope) {
                        functionEvalVisitor(name, func)(path);
                        DFSDispatcherMatchVisitor(ast, name, func, scope);
                    }
                }
            });
        });
    if (funcname.length > 0)
        console.log(dispatcherName + ":" + funcname)
}
*/

function DispatcherMatchVisitor(ast, dispatcherName) {
    let funcname = [];
    traverse(ast, {
        VariableDeclarator(path) {
            if (path.node.init && path.node.init.name === dispatcherName) {
                funcname.push(path.node.id.name);
            }
        }
    });
    return funcname;
}

function DFSDispatcherMatchVisitor(ast, dispatcherName, func) {
    let funcname = DispatcherMatchVisitor(ast, dispatcherName)
    funcname.forEach(
        (name) => {
            require('@babel/traverse').default(ast, functionEvalVisitor(name, func));
            DFSDispatcherMatchVisitor(ast, name, func);
        });

    //remove all funcname declaration
    traverse(ast, {
        VariableDeclarator(path) {
            if (funcname.includes(path.node.id.name)) {
                removeReference(path);
                path.remove();
            }
        }
    });
    if (funcname.length > 0)
        console.log(dispatcherName + ":" + funcname)
}
/**
这个 `inlineFunctionExpressionVisitor` 函数处理的是那些直接调用函数表达式的代码块。如果一个函数调用的调用者是一个函数表达式，并且这个函数表达式的体只有一个语句，那么这个函数调用就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
(function(x, y) {
    return x + y;
})(1, 2);
```

在这个例子中，`(function(x, y) { return x + y; })(1, 2)` 是一个函数调用，它的调用者是一个函数表达式 `function(x, y) { return x + y; }`，这个函数表达式的体只有一个语句 `return x + y;`。因此，`inlineFunctionExpressionVisitor` 函数会将这个函数调用替换为它的返回值，如下所示：

```javascript
1 + 2;
```

注意，`(function(x, y) { return x + y; })(1, 2)` 被替换为它的返回值 `1 + 2`。
 */
const inlineFunctionExpressionVisitor = {
    CallExpression(path) {
        if (path.node.callee.type === 'FunctionExpression' && hasSingleStatement(path.node.callee)) {
            if (path.node.callee.id !== null) inlineNamedFunction(path.get("callee"));
            inlineFunction(path.get("callee"), path);
        }
    }
}

/**
这个 `evalVisitor` 函数处理的是那些包含一元表达式、二元表达式、函数调用和条件表达式的代码块。如果一个表达式的值可以确定，那么这个表达式就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let result1 = !false;
let result2 = 1 + 2;
let result3 = Math.max(1, 2, 3);
let result4 = true ? "true branch" : "false branch";
```

在这个例子中，`!false` 是一个一元表达式，它的值可以确定为 `true`，因此这个一元表达式会被处理。
`1 + 2` 是一个二元表达式，它的值可以确定为 `3`，因此这个二元表达式会被处理。
`Math.max(1, 2, 3)` 是一个函数调用，它的值可以确定为 `3`，因此这个函数调用会被处理。
`true ? "true branch" : "false branch"` 是一个条件表达式，它的值可以确定为 `"true branch"`，因此这个条件表达式会被处理。
因此，`evalVisitor` 函数会将这些表达式替换为它们的值，如下所示：

```javascript
let result1 = true;
let result2 = 3;
let result3 = 3;
let result4 = "true branch";
```

注意，`!false` 被替换为它的值 `true`，`1 + 2` 被替换为它的值 `3`，`Math.max(1, 2, 3)` 被替换为它的值 `3`，`true ? "true branch" : "false branch"` 被替换为它的值 `"true branch"`。
 */
const evalVisiotr = {
    "UnaryExpression|BinaryExpression|CallExpression|ConditionalExpression"(path) {
        const { confident, value } = path.evaluate();
        if (confident) {
            removeReference(path);
            path.replaceInline(types.valueToNode(value));
            path.skip();
        }
    }
}


/**
这个 `removeSymbolVisitor` 函数处理的是那些包含未被引用的变量声明的代码块。
如果一个变量声明的标识符没有被修改过，并且没有被引用，那么这个变量声明就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let unusedVariable = "This variable is not used anywhere.";
let usedVariable = "This variable is used.";
console.log(usedVariable);
```

在这个例子中，`let unusedVariable = "This variable is not used anywhere.";` 是一个变量声明，它的标识符 `unusedVariable` 没有被修改过，并且没有被引用，因此这个变量声明会被处理。
`let usedVariable = "This variable is used.";` 是另一个变量声明，它的标识符 `usedVariable` 被引用了，因此这个变量声明不会被处理。
因此，`removeSymbolVisitor` 函数会将未被引用的变量声明删除，如下所示：

```javascript
let usedVariable = "This variable is used.";
console.log(usedVariable);
```

注意，`let unusedVariable = "This variable is not used anywhere.";` 被删除，因为它的标识符 `unusedVariable` 没有被引用。
 */
const removeSymbolVisitor = {
    VariableDeclarator(path) {
        const binding = path.scope.getBinding(path.node.id.name);
        // 如标识符被修改过，则不能进行删除动作。
        if (!binding || binding.constantViolations.length > 0) {
            return;
        }
        // 未被引用
        if (!binding.referenced) {
            path.remove();
        }
    }
}
/**
这个 `inlineFunctionCallVisitor` 函数处理的是那些调用了一个对象的方法的表达式。
这个方法必须是一个函数，这个函数的体只有一个返回语句，这个返回语句的参数数量必须和函数调用的参数数量相同。

以下是一个会被这个函数处理的示例：

```javascript
let obj = {
    "add": function(x, y) {
        return x + y;
    }
};

let result = obj.add(1, 2);
```

在这个例子中，`obj.add(1, 2)` 是一个调用表达式，它调用了一个对象的方法 `obj.add`，这个方法是一个函数 `function(x, y) { return x + y; }`，这个函数的体只有一个返回语句 `return x + y;`，这个返回语句的参数数量 `2` 和函数调用的参数数量 `2` 相同。
因此，`inlineFunctionCallVisitor` 函数会将这个调用表达式替换为它的返回值，如下所示：

```javascript
let obj = {
    "add": function(x, y) {
        return x + y;
    }
};

let result = 1 + 2;
```

注意，`obj.add(1, 2)` 被替换为它的返回值 `1 + 2`。
 */
const inlineFunctionCallVisitor = {
    CallExpression(path) {
        const callee = path.node.callee;

        // 确认调用的函数是一个对象的属性
        if (types.isMemberExpression(callee) && types.isIdentifier(callee.object) && types.isIdentifier(callee.property)) {
            const objectName = callee.object.name;
            const propertyName = callee.property.name;

            console.log(`Found a CallExpression: ${objectName}.${propertyName}`);

            // 递归查找绑定函数
            function findBinding(scope, name) {
                if (!scope) return undefined;
                const binding = scope.getBinding(name);
                if (binding) {
                    return binding;
                }
                return findBinding(scope.parent, name);
            }

            const binding = findBinding(path.scope, objectName);
            if (binding && types.isVariableDeclarator(binding.path.node)) {
                console.log(`Found binding for object: ${objectName}`);

                const init = binding.path.node.init;

                if (types.isObjectExpression(init)) {
                    const properties = init.properties;
                    const property = properties.find((prop) => {
                        return types.isObjectProperty(prop) && prop.key.value === propertyName
                    });

                    if (property && types.isFunctionExpression(property.value)) {
                        console.log(`Found property "${propertyName}" in object, which is a function`);

                        const func = property.value;

                        // 确认函数体只有一个 return 语句
                        if (func.body.body.length === 1 && types.isReturnStatement(func.body.body[0])) {
                            console.log(`Function "${propertyName}" has a single return statement`);

                            const returnStatement = func.body.body[0];
                            const returnValue = returnStatement.argument;

                            // 替换函数调用的参数
                            const args = path.node.arguments;
                            const params = func.params;

                            if (params.length === args.length) {
                                console.log(`Replacing function call with return value`);

                                let newExpression = types.cloneDeep(returnValue);

                                // 替换参数
                                params.forEach((param, index) => {
                                    newExpression = replaceIdentifier(path, newExpression, param.name, args[index]);
                                });

                                console.log(`Replacing ${objectName}.${propertyName}(${args.map(arg => arg.value).join(", ")}) with ${newExpression}`);

                                path.replaceWith(newExpression);
                            }
                        }
                    } else {
                        console.log(`Property "${propertyName}" is not a function or not found`);
                    }
                } else {
                    console.log(`Object "${objectName}" is not an ObjectExpression`);
                }
            } else {
                console.log(`No binding found for object: ${objectName}`);
            }
        }
    }
};

// 替换表达式中的 Identifier
function replaceIdentifier(parentPath, node, name, replacement) {
    traverse(node, {
        Identifier(path) {
            if (path.node.name === name) {
                console.log(`Replacing identifier ${name} with ${replacement}`);
                path.replaceWith(replacement);
            }
        }
    }, parentPath.scope, parentPath);
    return node;
}


/**
这个 `removeMemberExpressionVisitor` 函数处理的是那些包含对象属性访问的代码块。
如果一个对象属性的值是一个字面量或者一个函数表达式，并且这个函数表达式没有引用，没有生成器，不是异步的，只有一个语句，并且不是递归的，那么这个对象属性就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let obj = {
    "message": "Hello, world!",
    "add": function(x, y) {
        return x + y;
    }
};

console.log(obj["message"]);
console.log(obj["add"](1, 2));
```

在这个例子中，`obj["message"]` 和 `obj["add"](1, 2)` 都是对象属性访问。
`obj["message"]` 的值是一个字符串字面量 `"Hello, world!"`，因此它会被处理。
`obj["add"](1, 2)` 的值是一个函数表达式 `function(x, y) { return x + y; }`，这个函数表达式没有引用，没有生成器，不是异步的，只有一个语句 `return x + y;`，并且不是递归的，因此它也会被处理。
因此，`removeMemberExpressionVisitor` 函数会将这些对象属性访问替换为它们的值，如下所示：

```javascript
console.log("Hello, world!");
console.log(function(x, y) { return x + y; });
```

注意，`obj["message"]` 被替换为它的值 `"Hello, world!"`，`obj["add"](1, 2)` 被替换为它的值 `function(x, y) { return x + y; }`。
 */
const removeMemberExpressionVisitor = {
    MemberExpression(path) {
        console.log('Visiting MemberExpression:', path.node);
        // Check if MemberExpression is in the left-hand side of an assignment
        if (path.parentPath.isAssignmentExpression() && path.parentPath.node.left === path.node) {
            console.log('Skipping processing for MemberExpression in the left-hand side of an assignment:', path.node);
            return;
        }
        if (path.node.property.type == 'StringLiteral') {
            console.log('Property is a StringLiteral:', path.node.property.value);

            // 递归查找绑定函数
            function findBinding(scope, name) {
                if (!scope) return undefined;
                console.log(JSON.stringify(Object.keys(scope.bindings)));
                const binding = scope.getBinding(name);
                if (binding) {
                    // Check if we are looking for the object's own property
                    if (binding.identifier === path.node.object) {
                        return undefined;
                    }
                    return binding;
                }
                return findBinding(scope.parent, name);
            }

            const binding = findBinding(path.scope, path.node.object.name);
            if (binding === undefined || binding.identifier === path.node.object) {
                console.log('Skipping processing for object\'s own property:', path.node.object.name);
                return;
            }
            if (binding !== undefined) {
                console.log('Found binding for object:', path.node.object.name);

                const objPath = binding.path;
                if (objPath.node.init !== null && objPath.node.init !== undefined && objPath.node.init.type === 'ObjectExpression') {
                    console.log('Object has an ObjectExpression initializer');

                    const objPropertiesPath = objPath.get("init.properties");
                    const propertyPath = objPropertiesPath.find((_path) => {
                        return _path.node.type === 'ObjectProperty' && _path.node.key.type === 'StringLiteral' && _path.node.key.value === path.node.property.value;
                    });

                    if (propertyPath === undefined) {
                        console.log('Property not found in object:', path.node.property.value);
                        return;
                    }

                    console.log('Found property in object:', propertyPath.node.key.value);

                    const node = propertyPath.node;
                    const value = node.value;

                    // 复制Node需要深拷贝
                    if (types.isLiteral(value)) {
                        console.log('Value is a Literal:', value);

                        //Literal不包含引用
                        if (types.isStringLiteral(node.value)) {
                            path.replaceWith(types.stringLiteral(value.value));
                            return;
                        }

                        console.log('Replacing with cloned Literal value');
                        replaceWith(path, types.cloneDeepWithoutLoc(node.value));
                    } else if (value.type === 'FunctionExpression') {
                        console.log('Value is a FunctionExpression');

                        //仅处理没有引用的FunctionExpression
                        if (value.id === null && value.generator === false && value.async === false && hasSingleStatement(value) && isRecursionFunction(propertyPath.get('value')) === false) {
                            console.log('FunctionExpression meets criteria, replacing');
                            replaceWith(path, types.cloneDeepWithoutLoc(node.value));
                        }
                    } else {
                        console.log('Value type is not handled, skipping');
                        return;
                    }
                }
            } else {
                console.log('No binding found for object:', path.node.object.name);
            }
        }
    }
};


const { types: t } = babel;
//buggy
const removeMemberExpressionVisitorV2 = {
    // 处理对象属性
    ObjectProperty(path) {
        if (path.node._visited) return;
        path.node._visited = true;

        const key = path.node.key;
        const value = path.node.value;
        console.log(`Visiting ObjectProperty: ${key.name || key.value}`);

        if (t.isLiteral(value)) {
            console.log(`Inlining literal value: ${value.value}`);
            path.replaceWith(t.objectProperty(key, value));
        }

        if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
            const result = path.evaluate();
            if (result.confident) {
                const newValue = t.valueToNode(result.value);
                if (!t.isNodeEqual(value, newValue)) {
                    console.log(`Inlining function result: ${result.value}`);
                    path.replaceWith(t.objectProperty(key, newValue));
                }
            }
        }
    },

    CallExpression(path) {
        if (path.node._visited) return;
        path.node._visited = true;

        console.log(`Visiting CallExpression: ${path.getSource()}`);
        const result = path.evaluate();
        if (result.confident) {
            const newValue = t.valueToNode(result.value);
            if (!t.isNodeEqual(path.node, newValue)) {
                console.log(`Inlining call result: ${result.value}`);
                path.replaceWith(newValue);
            }
        }
    },

    VariableDeclarator(path) {
        if (path.node._visited) return;
        path.node._visited = true;

        const init = path.node.init;
        console.log(`Visiting VariableDeclarator: ${path.node.id.name}`);

        if (t.isLiteral(init)) {
            console.log(`Inlining literal value: ${init.value}`);
            path.replaceWith(t.variableDeclarator(path.node.id, init));
        }

        if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
            const result = path.evaluate();
            if (result.confident) {
                const newValue = t.valueToNode(result.value);
                if (!t.isNodeEqual(init, newValue)) {
                    console.log(`Inlining function result: ${result.value}`);
                    path.replaceWith(t.variableDeclarator(path.node.id, newValue));
                }
            }
        }
    },

    ExpressionStatement(path) {
        if (path.node._visited) return;
        path.node._visited = true;

        const expr = path.node.expression;
        console.log(`Visiting ExpressionStatement:`);

        const result = path.evaluate();
        if (result.confident) {
            const newValue = t.valueToNode(result.value);
            if (!t.isNodeEqual(expr, newValue)) {
                console.log(`Inlining expression result: ${result.value}`);
                path.replaceWith(t.expressionStatement(newValue));
            }
        }
    }
};

/*
这个 `unreachablePathVisitor` 函数处理的是那些包含不可达路径的 if 语句、条件表达式和 while 语句。
如果一个 if 语句或条件表达式的测试条件可以确定为真或假，那么这个 if 语句或条件表达式就会被处理。
如果一个 while 语句的测试条件可以确定为假，那么这个 while 语句就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
if (true) {
    console.log("True branch");
} else {
    console.log("False branch");
}

while (false) {
    console.log("Loop body");
}
```

在这个例子中，`if (true) { ... } else { ... }` 是一个 if 语句，它的测试条件 `true` 可以确定为真，因此这个 if 语句会被处理。
`while (false) { ... }` 是一个 while 语句，它的测试条件 `false` 可以确定为假，因此这个 while 语句会被处理。
因此，`unreachablePathVisitor` 函数会将这些语句替换或删除，如下所示：

```javascript
console.log("True branch");
```

注意，原来的 if 语句被替换为它的真分支，而原来的 while 语句被删除，因为它的测试条件为假，所以它的主体是不可达的。
 */
const unreachablePathVisitor = {
    "IfStatement|ConditionalExpression"(path) {
        const { confident, value } = path.get("test").evaluate();
        if (confident) {
            if (value) {
                replaceWith(path, types.cloneDeepWithoutLoc(path.node.consequent));
            } else {
                if (path.node.alternate !== null) {
                    replaceWith(path, types.cloneDeepWithoutLoc(path.node.alternate));
                } else {
                    removeReference(path);
                    path.remove();
                }
            }
        }
    },
    WhileStatement(path) {
        const { confident, value } = path.get("test").evaluate();
        if (confident && value === false) {
            removeReference(path);
            path.remove();
        }
    }
}

/**
这个 `callFunctionReverseVisitor` 函数处理的是那些调用了一个成员表达式的调用表达式。
这个成员表达式的对象可以是任何表达式，但是它的属性必须是一个字符串字面量，并且它必须是一个计算属性。
然后，这个成员表达式在其他地方被调用时，会被替换为一个非计算属性。

以下是一个会被这个函数处理的示例：

```javascript
let obj = {
    "add": function(x, y) {
        return x + y;
    }
};

let result = obj["add"](1, 2);
```

在这个例子中，`obj["add"](1, 2)` 是一个调用表达式，它调用了一个成员表达式 `obj["add"]`，
这个成员表达式的对象 `obj` 是一个标识符，这个标识符绑定到一个对象字面量 `{ "add": function(x, y) { return x + y; } }`，
并且它的属性 `"add"` 是一个字符串字面量，这个字符串字面量是一个计算属性。
因此，`callFunctionReverseVisitor` 函数会将这个成员表达式替换为一个非计算属性，如下所示：

```javascript
let obj = {
    "add": function(x, y) {
        return x + y;
    }
};

let result = obj.add(1, 2);
```

注意，`obj["add"]` 被替换为 `obj.add`，因为 `obj.add` 是这个成员表达式的非计算属性形式。
 */
const callFunctionReverseVisitor = {
    CallExpression(path) {
        //callee可以为Expression | Super | V8IntrinsicIdentifier，这里只要MemberExpression
        if (path.node.callee.type === "MemberExpression") {
            const callee = path.node.callee;
            if (callee.computed === true && callee.property.type === "StringLiteral") {
                callee.computed = false
                const idxPath = path.get("callee.property")
                replaceWith(idxPath, types.identifier(callee.property.value))
                console.log("callFunctionReverseVisitor:" + path.node)
            }
        }
    }
}
/**
这个 `switchControlsFlowFlatteningVisitor` 函数处理的是那些包含特定 while 循环和 switch 语句的代码块。这个 while 循环的条件必须始终为真，而且它的主体必须是一个包含 switch 语句和 break 语句的块语句。
这个 switch 语句的判别式必须是一个成员表达式，其对象是一个标识符，这个标识符必须绑定到一个数组字面量。然后，这个 switch 语句的每个 case 必须以 continue 语句结束。

以下是一个会被这个函数处理的示例：

```javascript
let arr = [0, 1, 2];
while (true) {
    switch (arr[i]) {
        case 0:
            console.log("Zero");
            continue;
        case 1:
            console.log("One");
            continue;
        case 2:
            console.log("Two");
            continue;
    }
    break;
}
```

在这个例子中，`while (true) { ... }` 是一个 while 循环，它的条件始终为真，而且它的主体是一个包含 switch 语句和 break 语句的块语句。
这个 switch 语句的判别式 `arr[i]` 是一个成员表达式，其对象 `arr` 是一个标识符，这个标识符绑定到一个数组字面量 `[0, 1, 2]`。
然后，这个 switch 语句的每个 case 都以 continue 语句结束。因此，`switchControlsFlowFlatteningVisitor` 函数会将这个 while 循环替换为一个新的代码块，如下所示：

```javascript
{
    console.log("Zero");
    console.log("One");
    console.log("Two");
}
```

注意，原来的 while 循环被替换为一个新的代码块，这个新的代码块包含了原来的 switch 语句的每个 case 的主体。
 */
const switchControlsFlowFlatteningVisitor = {
    WhileStatement(path) {
        const { confident: whileConfident, value: whileValue } = path.get("test").evaluate();
        if (!(whileConfident === true && whileValue === true)) return;
        if (!(path.node.body.type === "BlockStatement")) return;
        const whileBodyNode = path.node.body;
        if (!(whileBodyNode.body.length === 2 && whileBodyNode.body[0].type === "SwitchStatement" && whileBodyNode.body[1].type === "BreakStatement")) return;
        const switchBodyNode = whileBodyNode.body[0];
        if (!(switchBodyNode.discriminant.type === "MemberExpression" && switchBodyNode.discriminant.object.type === "Identifier")) return;
        const listBinding = path.scope.getBinding(switchBodyNode.discriminant.object.name)
        if (listBinding === undefined) return;
        if (!(listBinding.path.node.type === "VariableDeclarator" && listBinding.path.node.init !== null)) return;
        const { confident: listConfident, value: listValue } = listBinding.path.get("init").evaluate();
        if (!(listConfident === true && Array.isArray(listValue))) return;
        const consequent = Object.fromEntries(switchBodyNode.cases.map(x => [x.test.value, x.consequent]));
        newCode = listValue.map(x => consequent[x]);
        if (newCode.some((x) => x === undefined)) return;
        if (newCode.some((x) => x.at(-1).type !== "ContinueStatement")) return;
        newCode = newCode.map((x) => x.slice(0, -1));
        newCode = newCode.flat();
        newCode = newCode.map((x) => types.cloneDeepWithoutLoc(x));
        newCodeStatement = types.blockStatement(newCode);
        replaceWith(path, newCodeStatement);
        console.log("switchControlsFlowFlatteningVisitor:" + path.node)
    }
}

/**
 * 这个 `inlineConstValueVisitor` 函数处理的是那些定义了常量值并在后续代码中使用这些常量的变量声明。如果一个变量声明的类型是 `const`，并且它的初始值是一个字面量或者一个标识符，那么这个变量声明就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
const PI = 3.14159;
let area = PI * r * r;
```

在这个例子中，`PI` 是一个常量，它的值是一个数字字面量 `3.14159`。然后，这个常量在 `PI * r * r` 中被使用。因此，`inlineConstValueVisitor` 函数会将这个常量的所有引用替换为它的值，如下所示：

```javascript
let area = 3.14159 * r * r;
```

注意，`PI` 被替换为 `3.14159`，因为 `3.14159` 是这个常量的值。
 */
const inlineConstValueVisitor = {
    VariableDeclaration(path) {
        if (path.node.kind !== "const") return;
        // declarations: Array<VariableDeclarator> (required)
        path.get("declarations").forEach(function (path) {
            if (path.node.init === null) return;
            if (!(types.isLiteral(path.node.init) || path.node.init.type === "Identifier")) return;
            let binding = path.scope.getBinding(path.node.id.name);
            if (binding) {
                console.log("inlineConstValue:" + path.node)
                binding.referencePaths.slice().forEach(function (_path) {
                    replaceWith(_path, types.cloneDeepWithoutLoc(path.node.init));
                });
            }
            else {
                console.log(path.node.id)
            }
            removeReference(path);
            path.remove();
        });
    }
}

/**
这个 `BinaryExpressionVisitor` 函数处理的是那些调用了一个函数表达式的调用表达式。
这个函数表达式必须有两个参数，并且它的函数体只包含一个返回二元表达式的语句。
然后，这个函数表达式在其他地方被调用时，会被替换为一个二元表达式。

以下是一个会被这个函数处理的示例：

```javascript
let result = (function(x, y) {
    return x + y;
})(1, 2);
```

在这个例子中，`(function(x, y) { return x + y; })(1, 2)` 是一个调用表达式，它调用了一个函数表达式，这个函数表达式有两个参数 `x` 和 `y`，并且它的函数体只包含一个返回 `x + y` 的语句。因此，`BinaryExpressionVisitor` 函数会将这个调用表达式替换为一个二元表达式，如下所示：

```javascript
let result = 1 + 2;
```

注意，`(function(x, y) { return x + y; })(1, 2)` 被替换为 `1 + 2`，因为 `1 + 2` 是这个调用表达式的结果。
 */
const BinaryExpressionVisitor = {
    CallExpression(path) {
        if (types.isFunctionExpression(path.node.callee)) {
            const func = path.node.callee;
            const args = path.node.arguments;
            const body = func.body.body[0];
            if (types.isReturnStatement(body) && args.length === 2 && types.isBinaryExpression(body.argument)) {
                const expression = body.argument;
                const inlineExpression = types.binaryExpression(
                    expression.operator,
                    args[0],
                    args[1]
                );
                console.log("BinaryExpressionVisitor:" + path.node)
                path.replaceWith(inlineExpression);
            }
        }
    }
}

const functionDefinitions = {};
const ignoreFunction = ["toString", "constructor", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "valueOf"];

/**
这个 `inlineKVBinaryExpressionVisitor` 函数处理的是那些包含特定函数调用的变量声明。
这些函数在对象属性中定义，并且它们的函数体只包含一个返回字面量的语句。然后，这些函数在其他地方被调用时，会被替换为一个二元表达式。

以下是一个会被这个函数处理的示例：

```javascript
let obj = {
    add: function(x, y) {
        return x + y;
    }
};

let result = obj.add(1, 2);
```

在这个例子中，`obj` 是一个对象，它有一个属性 `add`，这个属性的值是一个函数，这个函数的函数体只包含一个返回 `x + y` 的语句。然后，这个函数在 `obj.add(1, 2)` 中被调用。
因此，`inlineKVBinaryExpressionVisitor` 函数会将这个函数调用替换为一个二元表达式，如下所示：

```javascript
let obj = {
    add: function(x, y) {
        return x + y;
    }
};

let result = 1 + 2;
```

注意，`obj.add(1, 2)` 被替换为 `1 + 2`，因为 `1 + 2` 是这个函数调用的结果。
 */
const inlineKVBinaryExpressionVisitor = {
    VariableDeclarator(path) {
        path.traverse({
            ObjectProperty(innerPath) {
                if (types.isFunctionExpression(innerPath.node.value)) {
                    innerPath.traverse({
                        AssignmentExpression(deepestPath) {
                            if (types.isFunctionExpression(deepestPath.node.right) && types.isBinaryExpression(deepestPath.node.right.body.body[0].argument)) {
                                functionDefinitions[deepestPath.node.left.property.value] = deepestPath.node.right.body.body[0].argument.operator;
                                deepestPath.remove();
                            }
                        },
                        CallExpression(deepestPath) {
                            if (types.isMemberExpression(deepestPath.node.callee) && deepestPath.node.callee.property.name in functionDefinitions && deepestPath.node.callee.property.name in ignoreFunction === false && deepestPath.node.callee.property.name) {
                                console.log("inlineKVExpressionVisitor:replace:" + deepestPath.node.callee.property.name)
                                const operator = functionDefinitions[deepestPath.node.callee.property.name];
                                const args = deepestPath.node.arguments;
                                const inlineExpression = types.binaryExpression(
                                    operator,
                                    args[0],
                                    args[1]
                                );
                                console.log("inlineKVExpressionVisitor:" + path.node)
                                deepestPath.replaceWith(inlineExpression);
                            }
                        }
                    });
                }
            }
        });
    }
}

const LiteralDefinitions = {};


/**
 * 这个 `UnicodeVisitor` 函数处理的是那些包含 Unicode 转义序列的字符串字面量。如果一个字符串字面量的值包含 `\u` 后跟四个十六进制数字的模式，那么这个字符串字面量就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let str = "Hello, \\u4E16\\u754C!";
```

在这个例子中，`str` 变量的值 `"Hello, \\u4E16\\u754C!"` 是一个字符串字面量，它包含 Unicode 转义序列 `\\u4E16` 和 `\\u754C`。因此，`UnicodeVisitor` 函数会将这些 Unicode 转义序列转换为它们所对应的字符，如下所示：

```javascript
let str = "Hello, 世界!";
```

注意，`\\u4E16` 和 `\\u754C` 被替换为 `世` 和 `界`，因为 `世` 和 `界` 是这些 Unicode 转义序列所对应的字符。
 */
const UnicodeVisitor = {
    StringLiteral(path) {
        const value = path.node.value;
        if (/\\u[\da-f]{4}/i.test(value)) {
            const originalString = JSON.parse(`"${value}"`);
            path.node.value = originalString;
        }
    }
}

/*
 这个 `arrayIndexVisitor` 函数处理的是那些访问数组元素但不在赋值表达式左侧的成员表达式。如果一个成员表达式的属性是数字字面量，并且它的对象绑定到一个数组字面量，那么这个成员表达式就会被处理。

以下是一个会被这个函数处理的示例：

let arr = [1, 2, 3];
console.log(arr[1]);


在这个例子中，`arr[1]` 是一个成员表达式，它的属性 `1` 是一个数字字面量，它的对象 `arr` 绑定到一个数组字面量 `[1, 2, 3]`。因此，`arrayIndexVisitor` 函数会将 `arr[1]` 替换为它所对应的数组元素，如下所示：

let arr = [1, 2, 3];
console.log(2);

注意，`arr[1]` 被替换为 `2`，因为 `2` 是数组 `arr` 在索引 `1` 的元素。
 */
const arrayIndexVisitor = {
    MemberExpression(path) {
        if (!path.parentPath.isAssignmentExpression({ left: path.node })) {
            if (types.isNumericLiteral(path.node.property)) {
                const binding = path.scope.getBinding(path.node.object.name);
                if (binding && ["var", "let", "const"].includes(binding.kind)) {
                    const arrayPath = binding.path;
                    if (types.isArrayExpression(arrayPath.node.init)) {
                        const index = path.node.property.value;
                        const element = arrayPath.node.init.elements[index];
                        if (element) {
                            path.replaceWith(types.cloneDeep(element));
                        }
                    }
                }
            }
        }
    }
}

/*
这个 marshalObjectVisitor 函数处理的是那些初始化为特定函数调用的变量声明。
特定的函数名由 marshalFuncName 参数给出。
如果一个变量被初始化为这个函数的调用，并且这个函数的第一个参数是一个字符串，那么这个变量就会被处理。

以下是一个会被这个函数处理的示例：

let foo = marshalFunc('bar');

在这个例子中，变量 foo 被初始化为 marshalFunc('bar') 的调用。
因此，marshalObjectVisitor 函数会删除这个变量声明，并且在后续的代码中，所有 foo 的引用都会被替换为 'bar'。
*/
function marshalObjectVisitor(ast, marshalFuncName) {
    let replacements = {};
    traverse(ast, {
        VariableDeclarator(path) {
            if (
                path.node.init &&
                types.isCallExpression(path.node.init) &&
                types.isIdentifier(path.node.init.callee) &&
                path.node.init.callee.name === marshalFuncName
            ) {
                replacements[path.node.id.name] = path.node.init.arguments[0].value;
                console.log("marshalObjectVisitor:" + path.node.id.name + ":" + path.node.init.arguments[0].value)
                path.remove();
            }
        }
    });
    traverse(ast, {
        Identifier(path) {
            if (replacements.hasOwnProperty(path.node.name)) {
                path.replaceWith(types.identifier(replacements[path.node.name]));
            }
        }
    });
}
/*
这个 constructFuncToClassVisitor 函数处理的是那些可以被转换为类的函数声明。
如果一个函数声明使用了 this 关键字，并且有一些方法被赋值给它的原型，那么这个函数就可以被转换为类。

以下是一个会被这个函数处理的示例：

function MyObject() {
    this.name = 'MyObject';
}

MyObject.prototype.sayHello = function() {
    console.log('Hello, ' + this.name);
};

在这个例子中，MyObject 函数使用了 this 关键字，并且有一个方法 sayHello 被赋值给它的原型。
因此，constructFuncToClassVisitor 函数会将这个函数转换为类，如下所示：

class MyObject {
    constructor() {
        this.name = 'MyObject';
    }

    sayHello() {
        console.log('Hello, ' + this.name);
    }
}
*/
function constructFuncToClassVisitor(ast) {
    traverse(ast, {
        FunctionDeclaration(path) {
            let usesThis = false;
            path.traverse({
                ThisExpression() {
                    usesThis = true;
                }
            });
            if (!usesThis) {
                return;
            }
            const className = path.node.id.name;
            const classBody = [];

            // 将构造函数转换为类的构造方法
            const constructorMethod = types.classMethod(
                "constructor",
                types.identifier("constructor"),
                [],
                path.node.body
            );
            classBody.push(constructorMethod);

            // 将原型方法转换为类的成员方法
            path.parentPath.traverse({
                AssignmentExpression(subPath) {
                    if (
                        types.isMemberExpression(subPath.node.left) &&
                        types.isIdentifier(subPath.node.left.object, { name: className }) &&
                        types.isIdentifier(subPath.node.left.property, { name: "prototype" })
                    ) {
                        const methodName = subPath.node.left.property.name;
                        const methodBody = subPath.node.right.body;
                        const classMethod = types.classMethod(
                            "method",
                            types.identifier(methodName),
                            [],
                            methodBody
                        );
                        classBody.push(classMethod);
                        subPath.remove();
                    }
                },
            });

            // 创建类声明
            const classDeclaration = types.classDeclaration(
                types.identifier(className),
                null,
                types.classBody(classBody),
                []
            );

            path.replaceWith(classDeclaration);
        },
    });
}
/*
这个 removeUnusedVariablesVisitor 函数处理的是那些在父作用域中定义但从未被读取过的变量。

以下是一个会被这个函数处理的示例：

function test() {
    let unusedVar = "I am unused";
    let usedVar = "I am used";
    console.log(usedVar);
}

在这个例子中，unusedVar 变量在 test 函数的作用域中定义，但从未被读取过。
因此，removeUnusedVariablesVisitor 函数会删除这个变量声明，如下所示：

function test() {
    let usedVar = "I am used";
    console.log(usedVar);
}

注意，usedVar 变量虽然也在 test 函数的作用域中定义，但它被 console.log 读取了，所以它不会被删除。
 */
const removeUnusedVariablesVisitor = {
    VariableDeclarator(path) {
        const variableName = path.node.id.name;

        const binding = path.scope.getBinding(variableName);
        if (path.scope.parent && binding.constantViolations.length === 0) {
            console.log(`Variable ${variableName} is never read, removing...`);
            path.remove();
        } else {
            console.log(`Variable ${variableName} is read or has no parent scope, keeping...`);
        }
    }
};
/*
以下是一个示例代码，它将被你的访问者处理：

```javascript
var a = 1;
var b = a;
var c = b;
```

在这个代码中，变量 `b` 和 `c` 的初始化器都是另一个变量。你的访问者将会把它们的初始化器替换为 `1`，这是变量 `a` 的初始化器。
 */
const replaceVariableWithItsInitializerVariableVisitor = {
    VariableDeclarator(path) {
        let init = path.node.init;
        let id = path.node.id;
        // 如果初始化器是一个标识符，进入循环
        while (types.isIdentifier(init)) {
            const binding = path.scope.getBinding(init.name);

            // 如果标识符在当前作用域中被定义为一个变量
            if (binding && types.isVariableDeclarator(binding.path.node) && types.isIdentifier(binding.path.node.init)) {
                if (init.name === id.name) {
                    console.log(`skipping redundant declaration ${id.name} = ${init.name}`);
                    //path.remove();
                    break;
                }
                console.log(`Replacing ${init.name} with its initializer ${binding.path.node.init.name}`);
                init = binding.path.node.init;
                path.node.init = init;
            } else {
                break;
            }

        }
    }
};

/**
`mergeObjectInitializationVisitor`访问者会查找所有的空对象声明，并将后续对这些对象的赋值合并到对象声明中。以下是一个会被这个访问者处理的示例代码：

```javascript
var obj = {};
obj.prop1 = "value1";
obj.prop2 = function() { return "value2"; };
obj["prop3"] = "value3";
```

在这个代码中，我们首先声明了一个空对象`obj`，然后我们对`obj`的`prop1`、`prop2`和`prop3`属性进行了赋值。
`mergeObjectInitializationVisitor`访问者会将这些赋值合并到`obj`的声明中，得到以下的代码：

```javascript
var obj = {
    prop1: "value1",
    prop2: function() { return "value2"; },
    prop3: "value3"
};
```

请注意，这个访问者只会处理在同一个作用域中的对象声明和赋值。
如果赋值发生在一个不同的作用域（例如在一个函数中），那么这个赋值就不会被合并到对象声明中。
 */
const mergeObjectInitializationVisitor = {
    VariableDeclarator(path) {
        if (types.isObjectExpression(path.node.init) && path.node.init.properties.length === 0) {
            const objectName = path.node.id.name;
            console.log(`Found empty object declaration for ${objectName}`);
            path.findParent((parentPath) => {
                if (parentPath.isProgram()) {
                    console.log(`Traversing the program to find assignments to ${objectName}`);
                    parentPath.traverse({
                        AssignmentExpression(innerPath) {
                            if (innerPath.node.left.object && innerPath.node.left.object.name === objectName) {
                                console.log(`Found assignment to ${objectName}, merging it into the object declaration`);
                                if (path.node.init && Array.isArray(path.node.init.properties)) {
                                    if (types.isCallExpression(innerPath.node.left.property)) {
                                        path.node.init.properties.push(types.objectProperty(innerPath.node.left.property, innerPath.node.right, true));
                                    } else if (types.isFunctionExpression(innerPath.node.right)) {
                                        path.node.init.properties.push(types.objectProperty(innerPath.node.left.property, innerPath.node.right));
                                    } else {
                                        path.node.init.properties.push(types.objectProperty(innerPath.node.left.property, innerPath.node.right));
                                    }
                                    innerPath.remove();
                                }
                            }
                        }
                    });
                    return true;
                }
            });
        }
    }
};

/*
这个访问者的目标是找到那些被重新赋值的变量，并将它们替换为原始的变量。以下是一个会被这个访问者处理的示例代码：

```javascript
var originalVar = function() { return "original"; };
var renamedVar = originalVar;
renamedVar();
```

在这个代码中，我们首先声明了一个函数`originalVar`，然后我们创建了一个新的变量`renamedVar`，并将它初始化为`originalVar`。然后我们调用了`renamedVar`。

`replaceRenamedVariableWithOriginalVariableVisitor`访问者会将`renamedVar`替换为`originalVar`，得到以下的代码：

```javascript
var originalVar = function() { return "original"; };
var renamedVar = originalVar;
originalVar();
```

请注意，这个访问者只会处理在同一个作用域中的变量声明和赋值。如果赋值发生在一个不同的作用域（例如在一个函数中），那么这个赋值就不会被替换。
 */
const replaceRenamedVariableWithOriginalVariableVisitor = {
    MemberExpression(path) {
        if (types.isIdentifier(path.node.object)) {
            const binding = path.scope.getBinding(path.node.object.name);

            // 如果标识符在当前作用域中被定义为一个变量
            if (binding && types.isVariableDeclarator(binding.path.node) && types.isIdentifier(binding.path.node.init)) {
                console.log(`Replacing ${path.node.object.name} with its original variable ${binding.path.node.init.name}`);
                path.node.object = binding.path.node.init;
            }
        }
    },
    CallExpression(path) {
        if (types.isIdentifier(path.node.callee)) {
            const binding = path.scope.getBinding(path.node.callee.name);

            // 如果标识符在当前作用域中被定义为一个变量
            if (binding && types.isVariableDeclarator(binding.path.node) && types.isIdentifier(binding.path.node.init)) {
                console.log(`Replacing ${path.node.callee.name} with its original variable ${binding.path.node.init.name}`);
                path.node.callee = binding.path.node.init;
            }
        }
    }
};

module.exports = { replaceRenamedVariableWithOriginalVariableVisitor,mergeObjectInitializationVisitor,replaceVariableWithItsInitializerVariableVisitor, removeUnusedVariablesVisitor, inlineFunctionCallVisitor, constructFuncToClassVisitor, inlineLiteralVisitor, marshalObjectVisitor, arrayIndexVisitor, UnicodeVisitor, inlineKVExpressionVisitor: inlineKVBinaryExpressionVisitor, BinaryExpressionVisitor, stringDecodeVisitor, inlineFunctionDeclarationVisitor, inlineFunctionExpressionVisitor, evalVisiotr, functionEvalVisitor, removeSymbolVisitor, removeMemberExpressionVisitor, removeMemberExpressionVisitorV2, unreachablePathVisitor, callFunctionReverseVisitor, switchControlsFlowFlatteningVisitor, inlineConstValueVisitor, DFSDispatcherMatchVisitor }