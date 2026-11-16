// Synthetic DOM, based on the class names recorded on 2026-11-07.
// This is not a captured platform page or evidence of server completion.
const documentRow = (title, status = 'unStart', options = {}) => `
  <li class="el-menu-item" role="menuitem" ${options.hidden ? 'hidden' : ''}>
    <div class="lecture-content"><i class="text-icon"></i><span class="lecture-title">${title}</span></div>
    ${status === 'none' ? '' : `<span class="lecture-status status-icon">
      ${status ? `<i class="${status}-icon"></i>` : ''}</span>`}
  </li>`;
const sectionDocument = (title, status = 'unStart') => `
  <div class="section-area"><div class="section-content">
    <i class="text-icon"></i><span class="section-title">${title}</span></div>
    <span class="section-status status-icon">${status ? `<i class="${status}-icon"></i>` : ''}</span></div>`;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
module.exports = { documentRow, sectionDocument, deferred };
