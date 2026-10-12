/* NAQAA Field Lab — evidence-first signal documentation. No automated archaeological claims. */
(function () {
  "use strict";
  function byId(id) { return document.getElementById(id); }
  function init() {
    var form = byId("evidence-report-form");
    if (!form) return;
    var photos = [];
    var input = byId("evidence-photo");
    var preview = byId("evidence-photo-preview");
    var status = byId("evidence-status");
    var report = null;

    function setStatus(message) { status.textContent = message; }
    function safeName(value) {
      return String(value || "naqaa-evidence-report").replace(/[^\u0600-\u06FFa-zA-Z0-9_-]+/g, "-").slice(0, 48) || "naqaa-evidence-report";
    }
    function downloadReport(data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = safeName(data.siteName) + "-evidence-report.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      photos = [];
      preview.textContent = "";
      if (!files.length) return;
      if (files.length > 6) {
        input.value = "";
        setStatus("الحد الأقصى 6 صور في عملية توثيق واحدة.");
        return;
      }
      if (files.some(function (file) { return !/^image\//.test(file.type) || file.size > 12 * 1024 * 1024; })) {
        input.value = "";
        setStatus("اختر صورًا فقط، وحجم كل صورة لا يتجاوز 12 ميغابايت.");
        return;
      }
      Promise.all(files.map(function (file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () { resolve({name:file.name || "evidence-image", dataUrl:String(reader.result || "")}); };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      })).then(function (results) {
        photos = results;
        results.forEach(function (photo) {
          var image = document.createElement("img");
          image.src = photo.dataUrl;
          image.alt = photo.name;
          preview.appendChild(image);
        });
        setStatus("تم تجهيز " + photos.length + " صور على الجهاز. لم تُرفع إلى خادم.");
      }).catch(function () { setStatus("تعذرت قراءة إحدى الصور."); });
    });

    var copyLocation = byId("copy-current-location");
    copyLocation.addEventListener("click", function () {
      var lat = byId("latitude");
      var lon = byId("longitude");
      if (lat && lon && lat.value && lon.value) {
        byId("evidence-latitude").value = lat.value;
        byId("evidence-longitude").value = lon.value;
        setStatus("نُسخت الإحداثيات من نموذج الموقع. راجعها قبل إصدار التقرير.");
      } else {
        setStatus("لا توجد إحداثيات في النموذج الأساسي. حدّد موقعك أولًا أو أدخل الإحداثيات يدويًا.");
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var siteName = byId("evidence-site-name").value.trim();
      var latText = byId("evidence-latitude").value.trim();
      var lonText = byId("evidence-longitude").value.trim();
      var lat = latText === "" ? null : Number(latText);
      var lon = lonText === "" ? null : Number(lonText);
      if (!siteName) { setStatus("أدخل اسم الموقع أولًا."); return; }
      if ((latText !== "" && !isFinite(lat)) || (lonText !== "" && !isFinite(lon)) ||
          (lat !== null && (lat < -90 || lat > 90)) || (lon !== null && (lon < -180 || lon > 180))) {
        setStatus("الإحداثيات غير صحيحة. خط العرض بين -90 و90 والطول بين -180 و180.");
        return;
      }
      var sourceDate = byId("evidence-source-date").value || null;
      report = {
        schema: "naqaa-evidence-report-v1",
        createdAt: new Date().toISOString(),
        siteName: siteName,
        featureType: byId("evidence-feature-type").value,
        evidenceSource: byId("evidence-source").value,
        sourceDate: sourceDate,
        latitude: lat,
        longitude: lon,
        coordinatesNote: byId("evidence-coordinate-note").value.trim(),
        description: byId("evidence-description").value.trim(),
        hypothesis: byId("evidence-hypothesis").value.trim(),
        alternativeExplanations: byId("evidence-alternatives").value.trim(),
        measurements: byId("evidence-measurements").value.trim(),
        confidence: byId("evidence-confidence").value,
        photos: photos,
        interpretationStatus: "user_observation_not_verified",
        limitations: [
          "هذا التقرير يوثق ملاحظات المستخدم ولا يمثل كشفًا آليًا أو إثباتًا لوجود دفائن أو آثار.",
          "قد تنتج العلامات الظاهرة عن أسباب طبيعية أو حديثة أو أثرية؛ يلزم تقييم مختص ومصادر مستقلة.",
          "لا تستخدم التقرير وحده للحفر أو الحفر الاستكشافي أو اتخاذ قرار مالي أو هندسي."
        ]
      };
      byId("evidence-report-preview").textContent =
        "تم إعداد تقرير توثيق مبدئي للموقع «" + siteName + "». " +
        "درجة التقييم المسجلة: " + byId("evidence-confidence").selectedOptions[0].textContent +
        ". هذه الدرجة تصف ملاحظة المستخدم وليست احتمالًا علميًا محسوبًا.";
      byId("download-evidence-report").disabled = false;
      setStatus("تم تجهيز تقرير التوثيق على هذا الجهاز فقط. لم تُرفع الصور ولم يُجرَ تحليل آلي لها.");
    });

    byId("download-evidence-report").addEventListener("click", function () {
      if (!report) { setStatus("أنشئ التقرير أولًا."); return; }
      downloadReport(report);
    });
    byId("reset-evidence-report").addEventListener("click", function () {
      form.reset();
      photos = [];
      report = null;
      preview.textContent = "";
      byId("evidence-report-preview").textContent = "";
      byId("download-evidence-report").disabled = true;
      setStatus("تم مسح النموذج من الشاشة. لم تُحفظ بياناته في حساب سحابي.");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}());