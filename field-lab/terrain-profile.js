/* NAQAA Field Lab — terrain profile + imported subsurface survey data.
   Surface elevations come from an online elevation dataset. Subsurface plots only visualize user-supplied measurements. */
(function () {
  "use strict";
  var byId = function (id) { return document.getElementById(id); };
  var lastTerrain = null;
  var undergroundRows = [];
  var ns = "http://www.w3.org/2000/svg";

  function elSvg(name, attrs, text) {
    var node = document.createElementNS(ns, name);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function showStatus(id, message, bad) {
    var node = byId(id);
    node.textContent = message;
    node.classList.toggle("terrain-error", !!bad);
  }
  function coordinates() {
    var lat = Number(byId("latitude").value);
    var lon = Number(byId("longitude").value);
    if (!byId("latitude").value.trim() || !byId("longitude").value.trim() ||
        !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("حدّد موقعك أولًا من زر «تحديد موقعي» أو أدخل إحداثيات صحيحة في النموذج الأساسي.");
    }
    return {lat: lat, lon: lon};
  }
  function destination(lat, lon, bearing, meters) {
    var radius = 6371000, br = bearing * Math.PI / 180;
    var p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180, d = meters / radius;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
    var l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return {lat: p2 * 180 / Math.PI, lon: ((l2 * 180 / Math.PI + 540) % 360) - 180};
  }
  function drawTerrain(rows) {
    var svg = byId("terrain-chart");
    svg.textContent = "";
    var W = 760, H = 300, left = 58, right = 20, top = 22, bottom = 48;
    var plotW = W-left-right, plotH = H-top-bottom;
    var values = rows.map(function (r) { return r.elevation; });
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var spread = Math.max(max-min, 2), lo = min - spread*0.12, hi = max + spread*0.12;
    function x(i) { return left + plotW*i/(rows.length-1); }
    function y(v) { return top + plotH*(hi-v)/(hi-lo); }
    [0, .25, .5, .75, 1].forEach(function (f) {
      var yy = top + plotH*f, val = hi-(hi-lo)*f;
      svg.appendChild(elSvg("line",{x1:left,y1:yy,x2:W-right,y2:yy,class:"terrain-gridline"}));
      svg.appendChild(elSvg("text",{x:left-9,y:yy+4,"text-anchor":"end",class:"terrain-axis"} , val.toFixed(0)+" م"));
    });
    var d = rows.map(function(r,i){return (i?"L":"M")+x(i).toFixed(2)+" "+y(r.elevation).toFixed(2);}).join(" ");
    var area = d+" L "+x(rows.length-1)+" "+(top+plotH)+" L "+left+" "+(top+plotH)+" Z";
    svg.appendChild(elSvg("path",{d:area,class:"terrain-area"}));
    svg.appendChild(elSvg("path",{d:d,class:"terrain-line"}));
    rows.forEach(function(r,i){
      if (i===0 || i===rows.length-1 || i===Math.floor(rows.length/2)) {
        svg.appendChild(elSvg("circle",{cx:x(i),cy:y(r.elevation),r:4,class:"terrain-dot"}));
        svg.appendChild(elSvg("text",{x:x(i),y:top+plotH+20,"text-anchor":"middle",class:"terrain-axis"},Math.round(r.distance)+" م"));
      }
    });
    svg.appendChild(elSvg("text",{x:W/2,y:H-5,"text-anchor":"middle",class:"terrain-axis"},"المسافة على المقطع"));
    byId("terrain-stats").textContent = "أدنى ارتفاع: "+min.toFixed(1)+" م • أعلى ارتفاع: "+max.toFixed(1)+" م • فرق الارتفاع: "+(max-min).toFixed(1)+" م";
    byId("terrain-chart-wrap").hidden = false;
  }
  function makeCSVRows(text) {
    var lines = text.replace(/^\uFEFF/,"").trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 3) throw new Error("يجب أن يحتوي CSV على صف عناوين وصفّين قياس على الأقل.");
    var headers = lines[0].split(/[;,\t]/).map(function(s){return s.trim().toLowerCase();});
    function col(names) { return headers.findIndex(function(h){return names.indexOf(h)>=0;}); }
    var di=col(["distance_m","distance","المسافة","المسافة_م"]), zi=col(["depth_m","depth","العمق","العمق_م"]), vi=col(["value","reading","amplitude","resistivity","القيمة","القراءة"]);
    if (di<0 || zi<0 || vi<0) throw new Error("عناوين CSV المطلوبة: distance_m,depth_m,value");
    return lines.slice(1).map(function(line){
      var c=line.split(/[;,\t]/).map(function(s){return s.trim();});
      var raw=[c[di],c[zi],c[vi]];
      if(raw.some(function(s){return s===undefined||s==="";}))return null;
      var nums=raw.map(Number);
      if(nums.some(function(n){return !Number.isFinite(n);}))return null;
      return {distance:nums[0],depth:nums[1],value:nums[2]};
    }).filter(function(r){return r!==null&&r.distance>=0&&r.distance<=50&&r.depth>=0;});
  }
  function drawUnderground(rows) {
    var svg=byId("underground-chart"); svg.textContent="";
    var W=760,H=330,left=64,right=20,top=24,bottom=48,pw=W-left-right,ph=H-top-bottom;
    var ds=rows.map(function(r){return r.distance;}), zs=rows.map(function(r){return r.depth;}), vs=rows.map(function(r){return r.value;});
    var dmin=Math.min.apply(null,ds),dmax=Math.max.apply(null,ds),zmin=Math.min.apply(null,zs),zmax=Math.max.apply(null,zs),vmin=Math.min.apply(null,vs),vmax=Math.max.apply(null,vs);
    if(dmax===dmin)dmax=dmin+1; if(zmax===zmin)zmax=zmin+1;
    var uniqueD=Array.from(new Set(ds)).sort(function(a,b){return a-b;}), uniqueZ=Array.from(new Set(zs)).sort(function(a,b){return a-b;});
    var cw=Math.max(2,pw/Math.max(1,uniqueD.length)), ch=Math.max(2,ph/Math.max(1,uniqueZ.length));
    rows.forEach(function(r){
      var f = vmax === vmin ? 0.5 : (r.value - vmin) / (vmax - vmin);
      var hue=220-220*f;
      var xx=left+(r.distance-dmin)/(dmax-dmin)*pw-cw/2;
      var yy=top+(r.depth-zmin)/(zmax-zmin)*ph-ch/2;
      svg.appendChild(elSvg("rect",{x:Math.max(left,xx),y:Math.max(top,yy),width:Math.min(cw+1,W-right-Math.max(left,xx)),height:Math.min(ch+1,H-bottom-Math.max(top,yy)),fill:"hsl("+hue+",65%, "+(88-35*f)+"%)",stroke:"#ffffff","stroke-width":"0.5"}));
    });
    svg.appendChild(elSvg("rect",{x:left,y:top,width:pw,height:ph,fill:"none",stroke:"#aabbb0"}));
    svg.appendChild(elSvg("text",{x:left,y:H-9,class:"terrain-axis"},"المسافة: "+dmin+"–"+dmax+" م"));
    svg.appendChild(elSvg("text",{x:left+pw,y:top-7,"text-anchor":"end",class:"terrain-axis"},"العمق: "+zmin+"–"+zmax+" م"));
    byId("underground-stats").textContent="عدد نقاط القياس: "+rows.length+" • نطاق القيم: "+vmin+" إلى "+vmax+" • تدرج اللون يوضح قيمة القياس فقط، وليس نوع المادة أو وجود دفينة.";
    byId("underground-chart-wrap").hidden=false;
  }
  function init() {
    var terrainButton=byId("terrain-generate");
    if(!terrainButton)return;
    terrainButton.addEventListener("click",function(){
      var origin, distance, bearing, count=25;
      try {
        origin=coordinates();
        distance=Number(byId("terrain-distance").value);
        bearing=Number(byId("terrain-bearing").value);
        if(!Number.isFinite(distance)||distance<5||distance>50)throw new Error("المسافة يجب أن تكون بين 5 و50 مترًا، ضمن قطر الموقع المحدد.");
        if(!Number.isFinite(bearing)||bearing<0||bearing>359)throw new Error("الاتجاه يجب أن يكون بين 0 و359 درجة.");
      } catch(e){showStatus("terrain-status",e.message,true);return;}
      terrainButton.disabled=true; showStatus("terrain-status","جارٍ جلب ارتفاعات سطح الأرض من مصدر الارتفاعات عبر الإنترنت…",false);
      var points=[];
      for(var i=0;i<count;i++){var along=-distance/2+distance*i/(count-1);points.push(destination(origin.lat,origin.lon,bearing,along));}
      var url="https://api.open-meteo.com/v1/elevation?latitude="+points.map(function(p){return p.lat.toFixed(5);}).join(",")+"&longitude="+points.map(function(p){return p.lon.toFixed(5);}).join(",");
      fetch(url).then(function(res){if(!res.ok)throw new Error("مصدر بيانات الارتفاعات غير متاح حاليًا (HTTP "+res.status+").");return res.json();}).then(function(data){
        if(!Array.isArray(data.elevation)||data.elevation.length!==points.length)throw new Error("لم يرجع المصدر بيانات ارتفاع كافية لهذا المقطع.");
        lastTerrain=data.elevation.map(function(e,i){return {distance:i*distance/(count-1),elevation:Number(e),latitude:points[i].lat,longitude:points[i].lon};});
        if(lastTerrain.some(function(r){return !Number.isFinite(r.elevation);}))throw new Error("بعض قيم الارتفاع غير صالحة.");
        drawTerrain(lastTerrain);
        showStatus("terrain-status","تم رسم مقطع تضاريس تقريبي من بيانات ارتفاعات سطح الأرض. ليس هذا مسحًا لما تحت الأرض.",false);
        byId("terrain-download").disabled=false;
      }).catch(function(e){showStatus("terrain-status",(e.message||"تعذر جلب بيانات الارتفاعات.")+" تحقق من الإنترنت ثم حاول مجددًا.",true);}).finally(function(){terrainButton.disabled=false;});
    });
    byId("terrain-download").addEventListener("click",function(){
      if(!lastTerrain)return;
      var data={schema:"naqaa-terrain-profile-v1",createdAt:new Date().toISOString(),source:"Open-Meteo Elevation API",profile:lastTerrain,limitations:["الارتفاعات بيانات تضاريس سطحية تقديرية وليست قياسات تحت سطح الأرض.","لا تستنتج منها المياه الجوفية أو الفراغات أو الدفائن."]};
      var a=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.href=url;a.download="naqaa-terrain-profile.json";a.click();URL.revokeObjectURL(url);
    });
    byId("underground-file").addEventListener("change",function(event){
      var file=event.target.files&&event.target.files[0]; if(!file)return;
      if(file.size>5*1024*1024){showStatus("underground-status","الملف أكبر من 5 ميغابايت.",true);return;}
      var reader=new FileReader();
      reader.onload=function(){try{undergroundRows=makeCSVRows(String(reader.result||""));if(undergroundRows.length<2)throw new Error("لم يتم العثور على نقطتي قياس صالحَتين على الأقل.");drawUnderground(undergroundRows);showStatus("underground-status","تم عرض بيانات الملف كما هي. يلزم تفسير متخصص وفق نوع الجهاز ومعايرته.",false);byId("underground-download").disabled=false;}catch(e){showStatus("underground-status",e.message,true);}};
      reader.onerror=function(){showStatus("underground-status","تعذرت قراءة الملف.",true);};reader.readAsText(file);
    });
    byId("underground-download").addEventListener("click",function(){
      if(!undergroundRows.length)return;
      var data={schema:"naqaa-imported-subsurface-profile-v1",createdAt:new Date().toISOString(),sourceFile:byId("underground-file").files[0].name,columns:["distance_m","depth_m","value"],measurements:undergroundRows,interpretation:"visualization_only_not_geological_diagnosis",limitations:["لا يُستنتج وجود مياه أو فراغ أو دفينة من قيمة القياس وحدها.","تفسير البيانات يتطلب نوع الجهاز وإعداداته ومعايرته وخبرة جيوفيزيائية."]};
      var a=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.href=url;a.download="naqaa-subsurface-profile.json";a.click();URL.revokeObjectURL(url);
    });
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
}());
