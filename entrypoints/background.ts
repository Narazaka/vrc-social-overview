export default defineBackground(() => {
  browser.action.onClicked.addListener(() => {
    browser.tabs.create({ url: browser.runtime.getURL('/social.html') });
  });
});
