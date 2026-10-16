/* NAQAA Field Lab — local-first prototype. No data is uploaded. */
(function () {
  "use strict";
  var DB_NAME = "naqaa-field-lab";
  var DB_VERSION = 1;
  var STORE = "records";
  var db = null;
  var map = null;
  var streetLayer = null;
  var satelliteLayer = null;
  var markers = [];
  var cameraStream = null;
  var pendingPhotos = [];
  var toastTimer = null;
  var typeLabels = {
    surface: "ملاحظة سطحية / تضاريس",
    rock: "صخر أو نقش محتمل",
    satellite: "ملاحظة من صورة فضائية",
    gpr: "بيانات GPR",
    ert: "بيانات ERT",
    water: "ملاحظة مرتبطة بالمياه",
    other: "أخرى"
  };
  var el = function (id) { return document.getElementById(id); };

  function toast(message) {
    var box = el("toast");
    box.textContent = message;
    box.classList.add("show");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { box.classList.remove("show"); }, 3200);
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) {
        reject(new Error("هذا المتصفح لا يدعم التخزين المحلي المطلوب."));
        return;
      }
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          var store = database.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      request.onsuccess = function () { db = request.result; resolve(db); };
      request.onerror = function () { reject(request.error || new Error("تعذر فتح التخزين المحلي.")); };
    });
  }

  function transact(mode, action) {
    return new Promise(function (resolve, reject) {
      if (!db) { reject(new Error("قاعدة البيانات غير جاهزة.")); return; }
      var tx = db.transaction(STORE, mode);
      var store = tx.objectStore(STORE);
      var request = action(store);
      if (request) {
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || tx.error); };
      } else {
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      }
    });
  }

  function allRecords() {
    return transact("readonly", function (store) { return store.getAll(); }).then(function (items) {
      return (items || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
    });
  }

  function apiSettings() {
    return {
      base: String(window.FIELD_LAB_API_BASE || "").trim().replace(/\/$/, ""),
      token: String(window.FIELD_LAB_AUTH_TOKEN || "")
    };
  }

  function cloudRequest(path, options) {
    var settings = apiSettings();
    if (!settings.base || !settings.token) return Promise.reject(new Error("يلزم ضبط الخادم وتسجيل الدخول للمزامنة."));
    options = options || {};
    options.headers = Object.assign({
      "Authorization": "Bearer " + settings.token,
      "Accept": "application/json"
    }, options.headers || {});
    return fetch(settings.base + path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.detail || "تعذرت مزامنة السجل.");
        return data;
      });
    });
  }

  function saveLocalRecord(record) {
    return transact("readwrite", function (store) { return store.put(record); });
  }

  function syncOneCloudRecord(record) {
    var copy = Object.assign({}, record, { storage: "cloud" });
    // Idempotent quota receipt prevents offline records from bypassing account limits.
    return cloudRequest("/usage/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "site", request_id: String(copy.id) })
    }).then(function () {
      return cloudRequest("/records/" + encodeURIComponent(copy.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ record: copy })
      });
    }).then(function () {
      return saveLocalRecord(copy).then(function () { return copy; });
    });
  }

  function syncCloudRecords() {
    var settings = apiSettings();
    if (!settings.base || !settings.token || !db) return Promise.resolve({ skipped: true });
    return allRecords().then(function (localRecords) {
      return localRecords.reduce(function (chain, record) {
        return chain.then(function () { return syncOneCloudRecord(record); });
      }, Promise.resolve());
    }).then(function () {
      return cloudRequest("/records", { method: "GET" });
    }).then(function (response) {
      var remoteRecords = Array.isArray(response.records) ? response.records : [];
      return allRecords().then(function (localRecords) {
        var localIds = new Set(localRecords.map(function (record) { return String(record.id); }));
        return remoteRecords.reduce(function (chain, record) {
          return chain.then(function () {
            if (!record || !record.id || localIds.has(String(record.id))) return;
            record.storage = "cloud";
            localIds.add(String(record.id));
            return saveLocalRecord(record);
          });
        }, Promise.resolve()).then(function () {
          return renderRecords().then(function () {
            return { uploaded: localRecords.length, downloaded: remoteRecords.length };
          });
        });
      });
    });
  }

  function makeId() {
    return "NQ-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  function fileToDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve({ name: file.name || "صورة ميدانية", type: file.type || "image/jpeg", data: reader.result }); };
      reader.onerror = function () { reject(new Error("تعذرت قراءة إحدى الصور.")); };
      reader.readAsDataURL(file);
    });
  }

  function showPendingPhotos() {
    var holder = el("photo-preview");
    holder.textContent = "";
    pendingPhotos.forEach(function (photo, index) {
      var wrap = document.createElement("div");
      wrap.className = "photo-item";
      var img = document.createElement("img");
      img.src = photo.data;
      img.alt = photo.name;
      var remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", "إزالة الصورة");
      remove.addEventListener("click", function () {
        pendingPhotos.splice(index, 1);
        showPendingPhotos();
      });
      wrap.appendChild(img);
      wrap.appendChild(remove);
      holder.appendChild(wrap);
    });
  }

  function renderRecords() {
    return allRecords().then(function (records) {
      var list = el("records-list");
      list.textContent = "";
      el("record-count").textContent = String(records.length);
      el("export-button").disabled = records.length === 0;
      el("clear-button").disabled = records.length === 0;
      if (!records.length) {
        var empty = document.createElement("div");
        empty.className = "empty-state";
        var icon = document.createElement("span");
        icon.textContent = "⌁";
        var title = document.createElement("h3");
        title.textContent = "لا توجد سجلات بعد";
        var p = document.createElement("p");
        p.textContent = "أنشئ أول سجل لتظهر هنا المواقع والصور والملاحظات.";
        empty.appendChild(icon); empty.appendChild(title); empty.appendChild(p);
        list.appendChild(empty);
        refreshMarkers([]);
        return;
      }
      records.forEach(function (record) {
        var card = document.createElement("article");
        card.className = "record-card";
        var main = document.createElement("div");
        var title = document.createElement("h3");
        title.textContent = record.siteName;
        var meta = document.createElement("div");
        meta.className = "record-meta";
        meta.textContent = new Date(record.createdAt).toLocaleString("ar");
        var tag = document.createElement("span");
        tag.className = "record-tag";
        tag.textContent = typeLabels[record.type] || "أخرى";
        main.appendChild(title); main.appendChild(meta); main.appendChild(tag);
        var actions = document.createElement("div");
        actions.className = "record-actions";
        var exportOne = document.createElement("button");
        exportOne.type = "button"; exportOne.className = "mini-button"; exportOne.textContent = "تصدير";
        exportOne.addEventListener("click", function () { downloadJSON(record, safeFileName(record.siteName) + ".json"); });
        var remove = document.createElement("button");
        remove.type = "button"; remove.className = "mini-button"; remove.textContent = "حذف";
        remove.addEventListener("click", function () {
          if (!window.confirm("هل تريد حذف سجل «" + record.siteName + "» من هذا الجهاز؟")) return;
          transact("readwrite", function (store) { return store.delete(record.id); })
            .then(renderRecords).then(function () { toast("تم حذف السجل من هذا الجهاز."); })
            .catch(function () { toast("تعذر حذف السجل."); });
        });
        actions.appendChild(exportOne); actions.appendChild(remove);
        card.appendChild(main); card.appendChild(actions);
        var coords = document.createElement("div");
        coords.className = "record-meta";
        coords.style.gridColumn = "1 / -1";
        coords.textContent = record.latitude !== null && record.longitude !== null
          ? "الإحداثيات: " + record.latitude + ", " + record.longitude + (record.coordinateSource ? " — " + record.coordinateSource : "")
          : "لم تُرفق إحداثيات";
        card.appendChild(coords);
        if (record.notes) {
          var notes = document.createElement("p"); notes.textContent = record.notes; card.appendChild(notes);
        }
        if (record.photos && record.photos.length) {
          var photoRow = document.createElement("div"); photoRow.className = "record-photos";
          record.photos.forEach(function (photo) {
            var img = document.createElement("img"); img.src = photo.data; img.alt = photo.name || "صورة ميدانية"; photoRow.appendChild(img);
          });
          card.appendChild(photoRow);
        }
        list.appendChild(card);
      });
      refreshMarkers(records);
    }).catch(function () { toast("تعذر قراءة السجلات المحلية."); });
  }

  function safeFileName(value) {
    return String(value || "naqaa-field-record").replace(/[^\u0600-\u06FFa-zA-Z0-9_-]+/g, "-").slice(0, 50) || "naqaa-field-record";
  }

  function downloadJSON(data, filename) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function initMap() {
    if (!window.L) {
      el("map").textContent = "تعذر تحميل مكتبة الخريطة. يمكنك حفظ الإحداثيات يدويًا.";
      return;
    }
    map = L.map("map").setView([31.5, 35.0], 3);
    streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
    satelliteLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Tiles &copy; Esri"
    });
    streetLayer.addTo(map);
    el("street-layer").addEventListener("click", function () { setLayer("street"); });
    el("satellite-layer").addEventListener("click", function () { setLayer("satellite"); });
    window.setTimeout(function () { if (map) map.invalidateSize(); }, 300);
  }

  function setLayer(which) {
    if (!map || !streetLayer || !satelliteLayer) return;
    if (which === "satellite") {
      if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
      satelliteLayer.addTo(map);
    } else {
      if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
      streetLayer.addTo(map);
    }
    el("street-layer").classList.toggle("active", which === "street");
    el("satellite-layer").classList.toggle("active", which === "satellite");
  }

  function refreshMarkers(records) {
    if (!map || !window.L) return;
    markers.forEach(function (marker) { map.removeLayer(marker); });
    markers = [];
    (records || []).forEach(function (record) {
      if (typeof record.latitude !== "number" || typeof record.longitude !== "number") return;
      var marker = L.marker([record.latitude, record.longitude]).addTo(map);
      marker.bindPopup("<strong></strong><br><span></span>");
      var popup = marker.getPopup().getElement();
      if (popup) {
        var strong = popup.querySelector("strong");
        var span = popup.querySelector("span");
        if (strong) strong.textContent = record.siteName;
        if (span) span.textContent = typeLabels[record.type] || "موقع مسجل";
      }
      markers.push(marker);
    });
  }

  function requestLocation() {
    if (!("geolocation" in navigator)) {
      el("location-status").textContent = "هذا المتصفح لا يدعم تحديد الموقع.";
      toast("تحديد الموقع غير متاح في هذا المتصفح.");
      return;
    }
    el("location-status").textContent = "بانتظار إذن الموقع من جهازك...";
    navigator.geolocation.getCurrentPosition(function (position) {
      var lat = position.coords.latitude;
      var lon = position.coords.longitude;
      el("latitude").value = lat.toFixed(6);
      el("longitude").value = lon.toFixed(6);
      el("coordinate-source").value = "GPS الجهاز؛ الدقة التقريبية " + Math.round(position.coords.accuracy) + " متر";
      el("location-status").textContent = "تم تحديد الموقع بعد موافقتك. الدقة التقريبية: " + Math.round(position.coords.accuracy) + " م.";
      if (map) map.setView([lat, lon], 15);
      el("open-map-link").href = "https://www.openstreetmap.org/?mlat=" + encodeURIComponent(lat) + "&mlon=" + encodeURIComponent(lon) + "#map=15/" + encodeURIComponent(lat) + "/" + encodeURIComponent(lon);
      toast("تم إرفاق الإحداثيات بالنموذج. احفظ السجل لتخزينها.");
    }, function (error) {
      var message = error.code === 1 ? "رفضت إذن الموقع. لن نستخدم الموقع؛ يمكنك إدخال الإحداثيات يدويًا." :
        error.code === 2 ? "تعذر تحديد الموقع. تحقق من إعدادات الموقع أو أدخل الإحداثيات يدويًا." :
        "انتهت مهلة تحديد الموقع. حاول مجددًا أو أدخل الإحداثيات يدويًا.";
      el("location-status").textContent = message;
      toast(message);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("الكاميرا تتطلب متصفحًا حديثًا واتصال HTTPS أو localhost. يمكنك اختيار صورة من الجهاز.");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(function (stream) {
        cameraStream = stream;
        var video = el("camera-preview");
        video.srcObject = stream;
        video.hidden = false;
        el("camera-placeholder").hidden = true;
        el("capture-button").hidden = false;
        el("camera-button").textContent = "إيقاف الكاميرا";
        toast("الكاميرا تعمل بعد إذنك. التقط الصورة عندما تكون جاهزًا.");
      })
      .catch(function (error) {
        var msg = error && error.name === "NotAllowedError" ? "لم تسمح بالوصول إلى الكاميرا. يمكنك تفعيل الإذن من إعدادات المتصفح أو اختيار صور من الجهاز." :
          "تعذر فتح الكاميرا. تأكد من HTTPS ومن عدم استخدام الكاميرا في تطبيق آخر.";
        toast(msg);
      });
  }

  function stopCamera() {
    if (cameraStream) cameraStream.getTracks().forEach(function (track) { track.stop(); });
    cameraStream = null;
    el("camera-preview").srcObject = null;
    el("camera-preview").hidden = true;
    el("camera-placeholder").hidden = false;
    el("capture-button").hidden = true;
    el("camera-button").textContent = "فتح الكاميرا";
  }

  function capturePhoto() {
    if (pendingPhotos.length >= 6) { toast("وصلت إلى الحد الأقصى: 6 صور لكل سجل. احذف صورة قبل التقاط أخرى."); return; }
    var video = el("camera-preview");
    if (!video.videoWidth || !video.videoHeight) { toast("انتظر حتى تصبح صورة الكاميرا جاهزة."); return; }
    var canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(function (blob) {
      if (!blob) { toast("تعذر التقاط الصورة."); return; }
      fileToDataURL(new File([blob], "field-photo-" + Date.now() + ".jpg", { type: "image/jpeg" }))
        .then(function (photo) { pendingPhotos.push(photo); showPendingPhotos(); toast("أُضيفت الصورة إلى النموذج. احفظ السجل للاحتفاظ بها."); })
        .catch(function () { toast("تعذر تجهيز الصورة."); });
    }, "image/jpeg", 0.88);
  }

  function parseCoordinate(value, min, max) {
    if (value.trim() === "") return null;
    var number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) throw new Error("تحقق من صحة الإحداثيات.");
    return number;
  }

  function saveRecord(event) {
    event.preventDefault();
    var siteName = el("site-name").value.trim();
    if (!siteName) { toast("اكتب اسم الموقع أو رمز العينة أولًا."); return; }
    var latitude, longitude;
    try {
      latitude = parseCoordinate(el("latitude").value, -90, 90);
      longitude = parseCoordinate(el("longitude").value, -180, 180);
    } catch (error) { toast(error.message); return; }
    if ((latitude === null) !== (longitude === null)) {
      toast("أدخل خط العرض وخط الطول معًا، أو اتركهما فارغين."); return;
    }
    var record = {
      id: makeId(),
      siteName: siteName,
      type: el("observation-type").value,
      latitude: latitude,
      longitude: longitude,
      coordinateSource: el("coordinate-source").value.trim(),
      notes: el("notes").value.trim(),
      measurements: el("measurements").value.trim(),
      photos: pendingPhotos.slice(),
      createdAt: Date.now(),
      appVersion: "0.1.0",
      storage: "local-device"
    };
    function persistRecord() {
      return transact("readwrite", function (store) { return store.add(record); })
        .then(function () {
          el("record-form").reset();
          pendingPhotos = [];
          showPendingPhotos();
          el("location-status").textContent = "لم يتم طلب الموقع. اضغط الزر إذا أردت إرفاق الإحداثيات.";
          stopCamera();
          return renderRecords();
        })
        .then(function () { return record; })
        .catch(function (error) {
          toast(error && error.name === "QuotaExceededError" ? "مساحة التخزين ممتلئة. صدّر سجلاتك واحذف الصور الكبيرة." : "تعذر الحفظ. قد تكون مساحة المتصفح ممتلئة.");
          throw error;
        });
    }

    var apiBase = String(window.FIELD_LAB_API_BASE || "").trim().replace(/\/$/, "");
    if (!apiBase) {
      persistRecord().then(function () { toast("تم حفظ السجل على هذا الجهاز فقط."); });
      return;
    }
    var authToken = String(window.FIELD_LAB_AUTH_TOKEN || "");
    if (!authToken) {
      toast("سجّل الدخول أولًا. يلزم ربط السجل بحصة الحساب في الخادم.");
      return;
    }
    fetch(apiBase + "/usage/consume", {
      method: "POST",
      headers: { "Authorization": "Bearer " + authToken, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ action: "site", request_id: record.id })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.detail || "تعذر التحقق من حصة المواقع.");
        return data;
      });
    }).then(function () {
      return persistRecord();
    }).then(function (savedRecord) {
      return syncOneCloudRecord(savedRecord).then(function () {
        return renderRecords().then(function () {
          toast("تم حفظ السجل ومزامنته مع الخادم.");
        });
      }).catch(function (error) {
        toast("حُفظ السجل على الجهاز، لكن المزامنة السحابية معلّقة: " + (error.message || "تحقق من الاتصال."));
      });
    }).catch(function (error) {
      toast(error.message || "تعذر احتساب حصة الموقع على الخادم. لم يتم حفظ السجل.");
    });
  }

  function exportAll() {
    allRecords().then(function (records) {
      downloadJSON({
        app: "NAQAA Field Lab",
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        note: "البيانات مصدرها سجلات المستخدم المحلية وليست تحليلًا علميًا معتمدًا.",
        records: records
      }, "naqaa-field-lab-export-" + new Date().toISOString().slice(0, 10) + ".json");
    }).catch(function () { toast("تعذر تصدير السجلات."); });
  }

  function clearAll() {
    if (!window.confirm("سيتم حذف جميع السجلات والصور المحفوظة في هذا المتصفح. هل صدّرت نسخة احتياطية؟")) return;
    transact("readwrite", function (store) { return store.clear(); })
      .then(renderRecords)
      .then(function () { toast("تم حذف جميع السجلات المحلية."); })
      .catch(function () { toast("تعذر حذف السجلات."); });
  }

  function init() {
    initMap();
    el("location-button").addEventListener("click", requestLocation);
    el("camera-button").addEventListener("click", function () {
      if (cameraStream) stopCamera(); else startCamera();
    });
    el("capture-button").addEventListener("click", capturePhoto);
    el("photo-input").addEventListener("change", function (event) {
      var files = Array.prototype.slice.call(event.target.files || []).filter(function (file) { return file.type.indexOf("image/") === 0; });
      if (!files.length) return;
      if (pendingPhotos.length + files.length > 6) { toast("الحد الأقصى 6 صور لكل سجل."); event.target.value = ""; return; }
      if (files.some(function (file) { return file.size > 12 * 1024 * 1024; })) { toast("حجم إحدى الصور يتجاوز 12 ميغابايت."); event.target.value = ""; return; }
      Promise.all(files.map(fileToDataURL)).then(function (photos) {
        pendingPhotos = pendingPhotos.concat(photos);
        showPendingPhotos();
        toast("تم تجهيز " + photos.length + " صورة. احفظ السجل للاحتفاظ بها.");
        event.target.value = "";
      }).catch(function () { toast("تعذرت قراءة الصور المختارة."); });
    });
    el("record-form").addEventListener("submit", saveRecord);
    el("export-button").addEventListener("click", exportAll);
    el("clear-button").addEventListener("click", clearAll);
    window.addEventListener("beforeunload", stopCamera);
    openDB().then(function () {
      return renderRecords().then(function () {
        return syncCloudRecords().catch(function () {
          // Keep the offline-first workspace usable if the network is unavailable.
        });
      });
    }).catch(function (error) {
      toast(error.message || "تعذر بدء التخزين المحلي.");
    });
    window.addEventListener("online", function () {
      syncCloudRecords().catch(function () {
        toast("تعذرت المزامنة الآن؛ ستبقى سجلاتك محفوظة محليًا.");
      });
    });
    window.FIELD_LAB_SYNC_RECORDS = function () {
      return syncCloudRecords();
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());