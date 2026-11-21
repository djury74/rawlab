const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + __dirname + '/guide.html');
  await p.pdf({ path: __dirname + '/../../public/Duncans-Photo-Lab-Guide.pdf', format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font:8pt Arial;color:#888;width:100%;padding:0 16mm;display:flex;justify-content:space-between"><span>Duncan\'s Photo Lab: a guide for new users</span><span class="pageNumber"></span></div>', margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' } });
  await b.close();
})();
