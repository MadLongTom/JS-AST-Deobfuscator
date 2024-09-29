# JS-AST-Deobfuscator
 A deobfuscate babel visitor. 基于babel的反混淆访问器
# Visitors
## inlineFunctionDeclarationVisitor
`inlineFunctionDeclarationVisitor` 函数将会尝试内联一些行为简单的函数，当函数没有被引用时将会将函数删除。

以下是一个会被这个函数处理的示例：

```javascript
function noReferenceFunction(x, y) {
    return x - y;
}

function simpleFunction(x, y) {
    return x + y;
}
let simpleFunctionResult = simpleFunction(1, 2);

function complexFunction(x,y){
    x = x + 1;
    return x + y;
}
let complexFunctionResult = complexFunction(1, 2);
```

在这个例子中，`function noReferenceFunction(x, y) { return x - y; }` 、 `function simpleFunction(x, y) { return x + y; }` 和 `function complexFunction(x,y){ x = x + 1; return x + y; }`是函数声明，它们的标识符分别是 `noReferenceFunction` 、 `simpleFunction` 和 `complexFunction` 。

其中`noReferenceFunction`在代码中没有被引用，因此将会被移除。`simpleFunction` 只用一条`return`语句，因此被认定为是简单的函数，此函数将会被内联到`simpleFunctionResult`，在内联后`simpleFunction`将不再具有引用而被移除。`complexFunction`具有两条及以上语句，因此被认定为是复杂的函数，不适合进行内联，因此将会不做修改。最后结果如下所示：

```javascript
let simpleFunctionResult = 1 + 2;
function complexFunction(x, y) {
  x = x + 1;
  return x + y;
}
let complexFunctionResult = complexFunction(1, 2);
```

## inlineLiteralVisitor
`inlineLiteralVisitor` 函数处理的是那些包含特定字面量的代码块。如果一个变量声明的初始化表达式是一个字符串字面量、数字字面量或布尔字面量，并且这个变量声明不在循环体内，那么这个变量声明就会被处理。

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
## functionEvalVisitor
`functionEvalVisitor` 函数用于处理复杂求值计算（如处理加密字符串），该Visitor需要提供需要被求值的函数名称以及用于求值的函数。

以下是一个会被这个函数处理的示例：

```javascript
var stringTable = ['string']
function loadString(idx) {
    //Some code used for anti debugging
    //...
    //Complex function processing
    //...
    return stringTable[idx];
}

let result = loadString(0);
```

通过`traverse(ast, functionEvalVisitor("loadString",(idx)=>['string'][idx]))`的方式调用`functionEvalVisitor`，可以把示例程序中的`loadString`函数调用都替换为`(idx)=>['string'][idx]`函数计算的结果。
因此处理后的函数结果如下：

```javascript
var stringTable = ['string'];
function loadString(idx) {
  //Some code used for anti debugging
  //...
  //Complex function processing
  //...
  return stringTable[idx];
}
let result = "string";
```

## DispatcherMatchExpressionVisitor
`DispatcherMatchExpressionVisitor` 函数处理的是那些包含特定表达式的抽象语法树（AST）。
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
## inlineFunctionExpressionVisitor
`inlineFunctionExpressionVisitor` 函数处理的是那些直接调用函数表达式的代码块。如果一个函数调用的调用者是一个函数表达式，并且这个函数表达式的体只有一个语句，那么这个函数调用就会被处理。

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
## evalVisitor
`evalVisitor` 函数处理的是那些包含一元表达式、二元表达式、函数调用和条件表达式的代码块。如果一个表达式的值可以确定，那么这个表达式就会被处理。

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
## removeSymbolVisitor
`removeSymbolVisitor` 函数处理的是那些包含未被引用的变量声明的代码块。
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
## inlineFunctionCallVisitor
 `inlineFunctionCallVisitor` 函数处理的是那些调用了一个对象的方法的表达式。
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
## removeMemberExpressionVisitor
`removeMemberExpressionVisitor` 函数处理的是那些包含对象属性访问的代码块。
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
let obj = {
  "message": "Hello, world!",
  "add": function (x, y) {
    return x + y;
  }
};
console.log("Hello, world!");
console.log(function (x, y) {
  return x + y;
}(1, 2));
```

注意，`obj["message"]` 被替换为它的值 `"Hello, world!"`，`obj["add"](1, 2)` 被替换为它的值 `1 + 2`。
 
 ## unreachablePathVisitor
 `unreachablePathVisitor` 函数处理的是那些包含不可达路径的 if 语句、条件表达式和 while 语句。
如果一个 if 语句或条件表达式的测试条件可以确定为真或假，那么这个 if 语句或条件表达式就会被处理。
如果一个 while 语句的测试条件可以确定为假，那么这个 while 语句就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
if (true) {
    console.log("True branch");
} else {
    console.log("False branch");
}

let num = true?1:2;

while (false) {
    console.log("Loop body");
}
```

在这个例子中，`if (true) { ... } else { ... }` 是一个 if 语句，它的测试条件 `true` 可以确定为真，因此这个 if 语句会被处理。
`let num = true?1:2`中三木运算符因同样属于条件判断语句而会被化简。
`while (false) { ... }` 是一个 while 语句，它的测试条件 `false` 可以确定为假，因此这个 while 语句会被处理。
因此，`unreachablePathVisitor` 函数会将这些语句替换或删除，如下所示：

```javascript
console.log("True branch");
let num = 1;
```

注意，原来的 if 语句被替换为它的真分支，而原来的 while 语句被删除，因为它的测试条件为假，所以它的主体是不可达的。
## callFunctionReverseVisitor
`callFunctionReverseVisitor` 函数处理的是那些调用了一个成员表达式的调用表达式。
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
## switchControlsFlowFlatteningVisitor
`switchControlsFlowFlatteningVisitor` 函数处理的是那些包含特定 while 循环和 switch 语句的代码块。这个 while 循环的条件必须始终为真，而且它的主体必须是一个包含 switch 语句和 break 语句的块语句。
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
## inlineConstValueVisitor
这个 `inlineConstValueVisitor` 函数处理的是那些定义了常量值并在后续代码中使用这些常量的变量声明。如果一个变量声明的类型是 `const`，并且它的初始值是一个字面量或者一个标识符，那么这个变量声明就会被处理。

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
## BinaryExpressionVisitor
`BinaryExpressionVisitor` 函数处理的是那些调用了一个函数表达式的调用表达式。
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
## inlineKVBinaryExpressionVisitor
`inlineKVBinaryExpressionVisitor` 函数处理的是那些包含特定函数调用的变量声明。
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
## UnicodeVisitor
`UnicodeVisitor` 函数处理的是那些包含 Unicode 转义序列的字符串字面量。如果一个字符串字面量的值包含 `\u` 后跟四个十六进制数字的模式，那么这个字符串字面量就会被处理。

以下是一个会被这个函数处理的示例：

```javascript
let str = "Hello, \\u4E16\\u754C!";
```

在这个例子中，`str` 变量的值 `"Hello, \\u4E16\\u754C!"` 是一个字符串字面量，它包含 Unicode 转义序列 `\\u4E16` 和 `\\u754C`。因此，`UnicodeVisitor` 函数会将这些 Unicode 转义序列转换为它们所对应的字符，如下所示：

```javascript
let str = "Hello, 世界!";
```

注意，`\\u4E16` 和 `\\u754C` 被替换为 `世` 和 `界`，因为 `世` 和 `界` 是这些 Unicode 转义序列所对应的字符。
## marshalObjectVisitor
marshalObjectVisitor 函数处理的是那些初始化为特定函数调用的变量声明。
特定的函数名由 marshalFuncName 参数给出。
如果一个变量被初始化为这个函数的调用，并且这个函数的第一个参数是一个字符串，那么这个变量就会被处理。

以下是一个会被这个函数处理的示例：
```javascript
let foo = marshalFunc('bar');
```
在这个例子中，变量 foo 被初始化为 marshalFunc('bar') 的调用。
因此，marshalObjectVisitor 函数会删除这个变量声明，并且在后续的代码中，所有 foo 的引用都会被替换为 'bar'。
## constructFuncToClassVisitor
constructFuncToClassVisitor 函数处理的是那些可以被转换为类的函数声明。
如果一个函数声明使用了 this 关键字，并且有一些方法被赋值给它的原型，那么这个函数就可以被转换为类。

以下是一个会被这个函数处理的示例：
```javascript
function MyObject() {
    this.name = 'MyObject';
}

MyObject.prototype.sayHello = function() {
    console.log('Hello, ' + this.name);
};
```
在这个例子中，MyObject 函数使用了 this 关键字，并且有一个方法 sayHello 被赋值给它的原型。
因此，constructFuncToClassVisitor 函数会将这个函数转换为类，如下所示：
```javascript
class MyObject {
    constructor() {
        this.name = 'MyObject';
    }

    sayHello() {
        console.log('Hello, ' + this.name);
    }
}
```
## removeUnusedVariablesVisitor
removeUnusedVariablesVisitor 函数处理的是那些在父作用域中定义但从未被读取过的变量。

以下是一个会被这个函数处理的示例：
```javascript
function test() {
    let unusedVar = "I am unused";
    let usedVar = "I am used";
    console.log(usedVar);
}
```
在这个例子中，unusedVar 变量在 test 函数的作用域中定义，但从未被读取过。
因此，removeUnusedVariablesVisitor 函数会删除这个变量声明，如下所示：
```javascript
function test() {
    let usedVar = "I am used";
    console.log(usedVar);
}
```
注意，usedVar 变量虽然也在 test 函数的作用域中定义，但它被 console.log 读取了，所以它不会被删除。
## replaceVariableWithItsInitializerVariableVisitor

```javascript
var a = 1;
var b = a;
var c = b;
```

在这个代码中，变量 `b` 和 `c` 的初始化器都是另一个变量。你的访问者将会把它们的初始化器替换为 `1`，这是变量 `a` 的初始化器。
## mergeObjectInitializationVisitor
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
## replaceRenamedVariableWithOriginalVariableVisitor
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
