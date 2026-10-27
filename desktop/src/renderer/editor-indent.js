export function indentationEdit(value, start, end, unindent = false) {
  if (!unindent && start === end) return { from: start, to: end, text: '\t', start: start + 1, end: start + 1 };
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const newline = value.indexOf('\n', last);
  const to = newline < 0 ? value.length : newline;
  let offset = from;
  const edits = value.slice(from, to).split('\n').map(line => {
    const remove = unindent ? (line.match(/^(?:\t| {1,4})/)?.[0].length || 0) : 0;
    const edit = { at: offset, remove, add: unindent ? '' : '\t' }; offset += line.length + 1; return edit;
  });
  const map = position => edits.reduce((mapped, edit) => edit.at <= position ? mapped + edit.add.length - Math.min(edit.remove, position - edit.at) : mapped, position);
  const text = value.slice(from, to).split('\n').map((line, i) => edits[i].add + line.slice(edits[i].remove)).join('\n');
  return { from, to, text, start: map(start), end: map(end) };
}
export function initEditorIndent() {
  document.addEventListener('keydown', event => {
    const editor = event.target;
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || !(editor instanceof HTMLTextAreaElement) || editor.readOnly || editor.disabled || !['query', 'trigger-body', 'object-source'].includes(editor.id)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const edit = indentationEdit(editor.value, editor.selectionStart, editor.selectionEnd, event.shiftKey);
    const direction = editor.selectionDirection, top = editor.scrollTop, left = editor.scrollLeft;
    editor.setSelectionRange(edit.from, edit.to);
    // Chromium's text insertion keeps native Undo/Redo. setRangeText is a fallback only.
    if (!document.execCommand('insertText', false, edit.text)) editor.setRangeText(edit.text, edit.from, edit.to, 'end');
    editor.setSelectionRange(edit.start, edit.end, direction);
    editor.scrollTop = top; editor.scrollLeft = left;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, true);
}
