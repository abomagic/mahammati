# رفع مهمّتي على Railway — خطوة بخطوة

1. أنشئ حسابًا على GitHub وحسابًا على Railway.
2. أنشئ Repository جديدًا على GitHub باسم mahammati.
3. ارفع محتويات هذا المجلد إلى الـRepository بحيث يكون package.json في جذر المشروع.
4. في Railway اختر New Project ثم Deploy from GitHub repo واختر mahammati.
5. في Variables أضف:
   ADMIN_EMAIL=بريدك
   ADMIN_PASSWORD=كلمة مرور قوية جدًا
   SESSION_SECRET=سلسلة طويلة عشوائية
   CURRENCY=EGP
   MIN_WITHDRAWAL_PIASTERS=2000
   PAYOUT_MODE=manual
   DATA_DIR=/data
6. أضف Volume للخدمة واجعل Mount Path هو:
   /data
7. من Networking اختر Generate Domain.
8. افتح الرابط العام واختبر تسجيل مستخدم، تنفيذ مهمة، اعتمادها، ثم طلب سحب.

مهم:
- لا تستخدم كلمة مرور الأدمن التجريبية عند النشر.
- لا تعتمد أي رصيد غير ممول فعليًا.
- السحب في هذا الإصدار محاسبي داخل المنصة، والتحويل النقدي نفسه يتم يدويًا ثم يسجل الأدمن مرجع التحويل.
