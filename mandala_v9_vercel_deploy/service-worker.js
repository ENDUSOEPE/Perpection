const CACHE='mandala-levelup-v18-13';
const CORE=['./index.html'];

self.addEventListener('install',event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>Promise.allSettled(CORE.map(url=>cache.add(url))))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==location.origin)return;

  // 위젯 페이지는 캐시 규칙(./index.html 덮어쓰기)에서 제외하고 네트워크에 그대로 맡긴다.
  // /widget(키 모드 SSR), /widget-app(로그인 모드) 모두 포함.
  if(/\/widget(-app)?(\.html)?$/.test(url.pathname))return;

  // 위젯 전용 API(/api/...)는 캐시하지 않는다.
  // 서버가 no-store로 응답하고, 키가 담긴 응답이 Cache Storage에 남지 않도록 통과시킨다.
  if(url.pathname.indexOf('/api/')===0)return;

  if(event.request.mode==='navigate'){
    event.respondWith(
      fetch(event.request,{cache:'no-store'})
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put('./index.html',copy));
          return response;
        })
        .catch(()=>caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request,{cache:'no-store'})
      .then(response=>{
        if(event.request.method==='GET'){
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,copy));
        }
        return response;
      })
      .catch(()=>caches.match(event.request))
  );
});
