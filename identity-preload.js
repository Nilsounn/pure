// Préchargé dans CHAQUE frame de la session de Pure (pages, iframes, fenêtres de connexion Google/Microsoft/…).
// navigator.userAgentData (Client Hints côté JavaScript) : sans cela, un site qui le lit voit « Chromium » seul,
// sans « Google Chrome », ce qui contredit l'user-agent et peut faire refuser la connexion.
const { webFrame } = require('electron');

try {
  if (/^https?:$/.test(location.protocol)) {
    const full = String(process.versions.chrome || '134.0.0.0');
    const major = full.split('.')[0];
    const plat = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : 'Windows';
    const code = '(function(){try{' +
      'var major=' + JSON.stringify(major) + ',full=' + JSON.stringify(full) + ',plat=' + JSON.stringify(plat) + ';' +
      'var brands=[{brand:"Chromium",version:major},{brand:"Google Chrome",version:major},{brand:"Not.A/Brand",version:"99"}];' +
      'var fvl=[{brand:"Chromium",version:full},{brand:"Google Chrome",version:full},{brand:"Not.A/Brand",version:"99.0.0.0"}];' +
      'var data={brands:brands,mobile:false,platform:plat,' +
      'toJSON:function(){return{brands:brands,mobile:false,platform:plat}},' +
      'getHighEntropyValues:function(){return Promise.resolve({brands:brands,mobile:false,platform:plat,platformVersion:"15.0.0",architecture:"x86",bitness:"64",model:"",uaFullVersion:full,fullVersionList:fvl,wow64:false})}};' +
      // Electron définit un objet window.chrome VIDE : dans un vrai Chrome il contient app, csi et loadTimes. Un objet vide est un indice classique d'Electron.
      'var c=window.chrome||(window.chrome={});' +
      'if(!c.app){c.app={isInstalled:false,InstallState:{DISABLED:"disabled",INSTALLED:"installed",NOT_INSTALLED:"not_installed"},RunningState:{CANNOT_RUN:"cannot_run",READY_TO_RUN:"ready_to_run",RUNNING:"running"},getDetails:function(){return null},getIsInstalled:function(){return false},runningState:function(){return "cannot_run"}};}' +
      'if(!c.csi){c.csi=function(){var t=performance.timing;return{onloadT:t.domContentLoadedEventEnd,startE:t.navigationStart,pageT:Date.now()-t.navigationStart,tran:15}};}' +
      'if(!c.loadTimes){c.loadTimes=function(){var t=performance.timing,n=t.navigationStart/1000;return{requestTime:n,startLoadTime:n,commitLoadTime:t.responseStart/1000,finishDocumentLoadTime:t.domContentLoadedEventEnd/1000,finishLoadTime:t.loadEventEnd/1000,firstPaintTime:n,firstPaintAfterLoadTime:0,navigationType:"Other",wasFetchedViaSpdy:true,wasNpnNegotiated:true,npnNegotiatedProtocol:"h2",wasAlternateProtocolAvailable:false,connectionInfo:"h2"}};}' +
      'Object.defineProperty(Navigator.prototype,"userAgentData",{get:function(){return data},configurable:true,enumerable:true});' +
      '}catch(e){}})();';
    webFrame.executeJavaScript(code).catch(() => { /* page fermée */ });
  }
} catch (e) { /* jamais bloquant pour la page */ }
