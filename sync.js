// Capa de sincronización opcional con Firebase (Auth + Firestore).
//
// Diseño: la app funciona 100% offline con localStorage sin esto. Si hay config de Firebase
// válida y hay red, esta capa se suma como mejora: login por email/contraseña, sincronía de
// comidas/feedback entre tus dispositivos, y una base de alimentos COMPARTIDA de solo lectura
// para todos los usuarios logueados (solo el dueño de la cuenta puede escribir en ella — ver
// firestore.rules).
//
// Expone todo en window.BitacoraSync para que el script clásico de index.html lo use sin
// necesidad de convertirse él mismo en módulo.

const FIREBASE_SDK_VERSION = '10.13.2';

function isConfigured() {
  const cfg = window.FIREBASE_CONFIG;
  return !!(cfg && cfg.apiKey && cfg.apiKey !== 'REEMPLAZAR');
}

const state = {
  ready: false,
  user: null,
  authListeners: [],
};

let app, auth, db;
let firestoreApi, authApi;

async function init() {
  if (!isConfigured()) {
    console.info('[sync] Sin config de Firebase: la app queda en modo local.');
    return;
  }
  try {
    const [{ initializeApp }, authMod, firestoreMod] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
    ]);
    authApi = authMod;
    firestoreApi = firestoreMod;

    app = initializeApp(window.FIREBASE_CONFIG);
    auth = authApi.getAuth(app);
    db = firestoreApi.initializeFirestore(app, {
      localCache: firestoreApi.persistentLocalCache({
        tabManager: firestoreApi.persistentMultipleTabManager(),
      }),
    });

    authApi.onAuthStateChanged(auth, (user) => {
      state.user = user;
      if (user) {
        watchUserCollection('meals', 'bitacora:meals:', (data) => JSON.stringify(data.list || []), window.refreshComidasPage);
        watchUserCollection('feedback', 'bitacora:feedback:', (data) => data.text || '', window.refreshComidasPage);
        watchUserDoc('routines', 'data', 'bitacora:routines', (data) => JSON.stringify(data.list || []), window.refreshRoutinePage);
        watchUserDoc('workoutHistory', 'data', 'bitacora:workoutHistory', (data) => JSON.stringify(data.list || []));
        watchUserDoc('profile', 'data', 'bitacora:profile', (data) => JSON.stringify(data || {}), window.refreshProfileUI);
        watchUserDoc('routineAnalysis', 'data', 'bitacora:routineAnalysis', (data) => JSON.stringify(data || {}), window.refreshRoutineAnalysis);
        watchUserDoc('rpg', 'stats', 'bitacora:rpg', (data) => JSON.stringify(data || {}), window.refreshHome);
        watchUserDoc('rpg', 'missions', 'bitacora:missions', (data) => JSON.stringify(data || {}), window.refreshHome);
        watchUserDoc('rpg', 'challenges', 'bitacora:challenges', (data) => JSON.stringify(data || {}), window.refreshHome);
        reconcileOnLogin();
      }
      state.authListeners.forEach((cb) => cb(user));
    });

    state.ready = true;
  } catch (err) {
    console.warn('[sync] No se pudo inicializar Firebase (¿sin conexión?)', err);
  }
}
const readyPromise = init();

function onAuthChange(cb) {
  state.authListeners.push(cb);
  if (state.ready) cb(state.user);
}

async function signUp(email, password) {
  await readyPromise;
  if (!auth) throw new Error('Firebase no está configurado.');
  await authApi.createUserWithEmailAndPassword(auth, email, password);
}

async function signIn(email, password) {
  await readyPromise;
  if (!auth) throw new Error('Firebase no está configurado.');
  await authApi.signInWithEmailAndPassword(auth, email, password);
}

async function logOut() {
  await readyPromise;
  if (!auth) return;
  await authApi.signOut(auth);
}

// --- Sync privado por usuario (users/{uid}/...): comidas, feedback, rutina, perfil ---
// Nada de esto se comparte entre cuentas — cada uid tiene sus propios documentos, a
// diferencia de foodKnowledge (que sí es compartida a propósito, ver firestore.rules).

function watchUserCollection(subcollection, localPrefix, valueFn, refreshFn) {
  const uid = state.user.uid;
  const colRef = firestoreApi.collection(db, 'users', uid, subcollection);
  firestoreApi.onSnapshot(colRef, (snap) => {
    snap.docChanges().forEach((change) => {
      const key = localPrefix + change.doc.id;
      if (change.type === 'removed') {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, valueFn(change.doc.data()));
      }
    });
    if (typeof refreshFn === 'function') refreshFn();
  }, (err) => console.warn('[sync] onSnapshot', subcollection, err));
}

function watchUserDoc(subcollection, docId, localKey, valueFn, refreshFn) {
  const uid = state.user.uid;
  const ref = firestoreApi.doc(db, 'users', uid, subcollection, docId);
  firestoreApi.onSnapshot(ref, (snap) => {
    if (snap.exists()) {
      localStorage.setItem(localKey, valueFn(snap.data()));
      if (typeof refreshFn === 'function') refreshFn();
    }
  }, (err) => console.warn('[sync] onSnapshot', subcollection, err));
}

// Se corre una vez cada vez que se loguea en un dispositivo: si la nube todavía no tiene
// nada para un tipo de dato (porque se creó localmente antes de loguearse, o en un
// dispositivo donde nunca se llegó a sincronizar) pero este dispositivo sí tiene datos
// reales guardados, los sube. Si la nube YA tiene algo, no se toca nada — gana la nube y
// baja normal por los listeners de arriba. Así se cierra el hueco de "lo armé sin estar
// logueado y nunca se subió a ningún lado".
async function reconcileDocIfEmpty(subcollection, docId, localKey, buildPayload) {
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, subcollection, docId);
    const snap = await firestoreApi.getDoc(ref);
    if (snap.exists()) return;
    const raw = localStorage.getItem(localKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const isEmpty = Array.isArray(parsed) ? parsed.length === 0 : (!parsed || Object.keys(parsed).length === 0);
    if (isEmpty) return;
    await firestoreApi.setDoc(ref, buildPayload(parsed));
  } catch (err) {
    console.warn('[sync] reconcileDocIfEmpty', subcollection, docId, err);
  }
}

async function reconcileCollectionIfEmpty(subcollection, localPrefix, buildPayload) {
  try {
    const colRef = firestoreApi.collection(db, 'users', state.user.uid, subcollection);
    const snap = await firestoreApi.getDocs(colRef);
    if (!snap.empty) return;
    const writes = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.indexOf(localPrefix) === 0) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const docId = key.slice(localPrefix.length);
        writes.push(firestoreApi.setDoc(firestoreApi.doc(db, 'users', state.user.uid, subcollection, docId), buildPayload(raw)));
      }
    }
    await Promise.all(writes);
  } catch (err) {
    console.warn('[sync] reconcileCollectionIfEmpty', subcollection, err);
  }
}

async function reconcileOnLogin() {
  const ts = () => firestoreApi.serverTimestamp();
  await Promise.all([
    reconcileDocIfEmpty('routines', 'data', 'bitacora:routines', (list) => ({ list, updatedAt: ts() })),
    reconcileDocIfEmpty('workoutHistory', 'data', 'bitacora:workoutHistory', (list) => ({ list, updatedAt: ts() })),
    reconcileDocIfEmpty('profile', 'data', 'bitacora:profile', (obj) => ({ ...obj, updatedAt: ts() })),
    reconcileDocIfEmpty('routineAnalysis', 'data', 'bitacora:routineAnalysis', (obj) => ({ ...obj, updatedAt: ts() })),
    reconcileDocIfEmpty('rpg', 'stats', 'bitacora:rpg', (obj) => ({ ...obj, updatedAt: ts() })),
    reconcileDocIfEmpty('rpg', 'missions', 'bitacora:missions', (obj) => ({ ...obj, updatedAt: ts() })),
    reconcileDocIfEmpty('rpg', 'challenges', 'bitacora:challenges', (obj) => ({ ...obj, updatedAt: ts() })),
    reconcileCollectionIfEmpty('meals', 'bitacora:meals:', (raw) => ({ list: JSON.parse(raw), updatedAt: ts() })),
    reconcileCollectionIfEmpty('feedback', 'bitacora:feedback:', (raw) => ({ text: raw, updatedAt: ts() })),
  ]);
}

async function pushMeals(dateKey, list) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'meals', dateKey);
    await firestoreApi.setDoc(ref, { list, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushMeals', err);
  }
}

async function pushFeedback(dateKey, text) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'feedback', dateKey);
    await firestoreApi.setDoc(ref, { text, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushFeedback', err);
  }
}

async function pushRoutines(routines) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'routines', 'data');
    await firestoreApi.setDoc(ref, { list: routines, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushRoutines', err);
  }
}

async function pushWorkoutHistory(history) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'workoutHistory', 'data');
    await firestoreApi.setDoc(ref, { list: history, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushWorkoutHistory', err);
  }
}

async function pushProfile(profile) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'profile', 'data');
    await firestoreApi.setDoc(ref, { ...profile, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushProfile', err);
  }
}

async function pushRoutineAnalysis(analysis) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'routineAnalysis', 'data');
    await firestoreApi.setDoc(ref, { ...analysis, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushRoutineAnalysis', err);
  }
}

async function pushRpgStats(stats) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'rpg', 'stats');
    await firestoreApi.setDoc(ref, { ...stats, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushRpgStats', err);
  }
}

async function pushMissions(missions) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'rpg', 'missions');
    await firestoreApi.setDoc(ref, { ...missions, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushMissions', err);
  }
}

async function pushChallenges(challenges) {
  if (!state.user) return;
  try {
    const ref = firestoreApi.doc(db, 'users', state.user.uid, 'rpg', 'challenges');
    await firestoreApi.setDoc(ref, { ...challenges, updatedAt: firestoreApi.serverTimestamp() });
  } catch (err) {
    console.warn('[sync] pushChallenges', err);
  }
}

// --- Base de alimentos compartida (foodKnowledge) + cola de pendientes ---

async function lookupFoodKnowledge(slug) {
  const localKey = 'bitacora:foodinfo:' + slug;
  const cached = localStorage.getItem(localKey);
  if (cached) return cached;
  if (!state.user || !db) return null;
  try {
    const ref = firestoreApi.doc(db, 'foodKnowledge', slug);
    const snap = await firestoreApi.getDoc(ref);
    if (snap.exists()) {
      const info = snap.data().info || '';
      if (info) localStorage.setItem(localKey, info);
      return info || null;
    }
  } catch (err) {
    console.warn('[sync] lookupFoodKnowledge', err);
  }
  return null;
}

async function saveFoodKnowledge(slug, text, info) {
  localStorage.setItem('bitacora:foodinfo:' + slug, info);
  if (!state.user || !db) return;
  try {
    const ref = firestoreApi.doc(db, 'foodKnowledge', slug);
    await firestoreApi.setDoc(ref, {
      food: text,
      info,
      addedBy: state.user.uid,
      updatedAt: firestoreApi.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[sync] saveFoodKnowledge (¿no sos el dueño de la cuenta que llena la base?)', err);
  }
}

async function queueFoodQuery(slug, text) {
  if (!state.user || !db) return;
  try {
    const ref = firestoreApi.doc(db, 'pendingFoodQueries', slug);
    const snap = await firestoreApi.getDoc(ref);
    if (!snap.exists()) {
      await firestoreApi.setDoc(ref, {
        text,
        requestedBy: state.user.uid,
        createdAt: firestoreApi.serverTimestamp(),
      });
    }
  } catch (err) {
    console.warn('[sync] queueFoodQuery', err);
  }
}

async function clearPendingFoodQuery(slug) {
  if (!state.user || !db) return;
  try {
    await firestoreApi.deleteDoc(firestoreApi.doc(db, 'pendingFoodQueries', slug));
  } catch (err) {
    console.warn('[sync] clearPendingFoodQuery (¿no sos el dueño?)', err);
  }
}

async function fetchAllPendingFoodQueries() {
  if (!state.user || !db) return [];
  try {
    const snap = await firestoreApi.getDocs(firestoreApi.collection(db, 'pendingFoodQueries'));
    return snap.docs.map((d) => ({ slug: d.id, text: d.data().text }));
  } catch (err) {
    console.warn('[sync] fetchAllPendingFoodQueries', err);
    return [];
  }
}

window.BitacoraSync = {
  isConfigured,
  onAuthChange,
  signUp,
  signIn,
  logOut,
  pushMeals,
  pushFeedback,
  pushRoutines,
  pushWorkoutHistory,
  pushProfile,
  pushRoutineAnalysis,
  pushRpgStats,
  pushMissions,
  pushChallenges,
  lookupFoodKnowledge,
  saveFoodKnowledge,
  queueFoodQuery,
  clearPendingFoodQuery,
  fetchAllPendingFoodQueries,
  get currentUser() { return state.user; },
};
window.dispatchEvent(new CustomEvent('bitacora-sync-ready'));
