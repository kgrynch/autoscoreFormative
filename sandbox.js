"use strict";

window.addEventListener('message', event => {
  // Security: only accept from parent
  if (event.source !== window.parent) {
    return;
  }

  const data = event.data;

  // We expect 'userCode' to be a string defining a function: "(answer) => { ... }"
  // We expect 'studentAnswer' to be the text string.
  if (data.userCode && data.id !== undefined) {
    try {
      // 1. Evaluate the string to create the function. 
      // userCode is something like "(ans) => { return 10; }"
      // eval() is generally discouraged, but strict sandbox + user input makes it the standard way here.
      // Alternatively, new Function requires a body, not an arrow definition. 
      // To support the arrow syntax generated in content.js, we wrap it.
      
      const evaluator = new Function("return " + data.userCode);
      const scoreFunction = evaluator(); // This returns the actual arrow function

      // 2. Run the function against the answer
      // Ensure studentAnswer is at least an empty string if undefined
      const answer = data.studentAnswer || "";
      const score = scoreFunction(answer);

      window.parent.postMessage({
        success: true,
        score: score,
        id: data.id
      }, '*');

    } catch (error) {
      window.parent.postMessage({
        success: false,
        error: error.message,
        id: data.id
      }, '*');
    }
  }
});