// Config de tu proyecto Firebase (activarte-4a30b). Firebase Console > Configuración del
// proyecto > Tus apps > SDK setup and configuration.
//
// El apiKey de un proyecto Firebase web NO es secreto: identifica el proyecto, pero no da
// acceso a nada por sí solo — el control de acceso real lo hacen las reglas de Firestore
// (ver firestore.rules), así que este archivo se puede subir a un repo público sin problema.
//
// Nota: sync.js importa el SDK de Firebase directo desde CDN (sin bundler), por eso acá
// solo se define el objeto de config como variable global en vez de usar `import`.
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAZXFHSuxQRdbxjevFs8Km4ltWmuSbed5w",
  authDomain: "activarte-4a30b.firebaseapp.com",
  projectId: "activarte-4a30b",
  storageBucket: "activarte-4a30b.firebasestorage.app",
  messagingSenderId: "766953779774",
  appId: "1:766953779774:web:88b017ba2803928c26576f",
};
