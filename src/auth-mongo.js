// Guarda la sesión de WhatsApp en MongoDB (gratis en Atlas) para que sobreviva a reinicios y despliegues de Render.
import { MongoClient } from 'mongodb';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

let cliente = null; // una sola conexión aunque el bot se reconecte

export async function usarAuthMongo(uri, { nombreDb = 'kleybot', coleccion = 'sesion_wa' } = {}) {
  if (!cliente) {
    cliente = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
    await cliente.connect();
    console.log('Sesión de WhatsApp: guardada en MongoDB.');
  }
  const col = cliente.db(nombreDb).collection(coleccion);

  const aTexto = (obj) => JSON.stringify(obj, BufferJSON.replacer);
  const deTexto = (txt) => JSON.parse(txt, BufferJSON.reviver);
  const leer = async (id) => {
    const doc = await col.findOne({ _id: id });
    return doc ? deTexto(doc.v) : null;
  };

  const creds = (await leer('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const datos = {};
          const docs = await col.find({ _id: { $in: ids.map((i) => `${tipo}-${i}`) } }).toArray();
          for (const d of docs) {
            let valor = deTexto(d.v);
            if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            datos[d._id.slice(tipo.length + 1)] = valor;
          }
          return datos;
        },
        set: async (datos) => {
          const ops = [];
          for (const tipo in datos) {
            for (const id in datos[tipo]) {
              const valor = datos[tipo][id];
              const _id = `${tipo}-${id}`;
              if (valor) ops.push({ replaceOne: { filter: { _id }, replacement: { _id, v: aTexto(valor) }, upsert: true } });
              else ops.push({ deleteOne: { filter: { _id } } });
            }
          }
          if (ops.length) await col.bulkWrite(ops, { ordered: false });
        }
      }
    },
    saveCreds: async () => {
      await col.replaceOne({ _id: 'creds' }, { _id: 'creds', v: aTexto(creds) }, { upsert: true });
    }
  };
}
