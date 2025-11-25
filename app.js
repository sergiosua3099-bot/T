// app.js
// Backend Innotiva + Replicate SDXL (image-to-image)

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;
const Replicate = require("replicate");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

// ========= CONFIG GENERAL =========

// Shopify
const SHOPIFY_STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN || "innotiva-vision.myshopify.com";
const SHOPIFY_STOREFRONT_TOKEN =
  process.env.SHOPIFY_STOREFRONT_TOKEN || process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "";

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Replicate
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// ========= MIDDLEWARE =========

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// ========= HELPERS =========

// Subir un buffer a Cloudinary y devolver secure_url
function subirACloudinaryDesdeBuffer(buffer, folder, prefix) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folder || "innotiva",
        public_id: `${prefix || "img"}_${Date.now()}`,
        resource_type: "image",
      },
      (err, result) => {
        if (err) return reject(err);
        return resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// Mensaje para la página de resultado
function generarMensajePersonalizado(productName, idea) {
  let base = `La elección de ${productName} encaja muy bien con el estilo de tu espacio. `;

  if (idea && idea.trim().length > 0) {
    base += `Tu idea de “${idea.trim()}” aporta un toque muy personal a la composición. `;
  } else {
    base += `Nos enfocamos en una composición equilibrada y minimalista para que el producto sea protagonista sin recargar el ambiente. `;
  }

  base +=
    "Esta visualización te ayuda a tomar decisiones con más confianza, viendo cómo se transforma tu espacio antes de comprar.";
  return base;
}

// Obtener productos de Shopify para el formulario
async function llamarShopifyProducts() {
  if (!SHOPIFY_STOREFRONT_TOKEN) {
    console.warn("No hay SHOPIFY_STOREFRONT_TOKEN definido, se intentará sin auth.");
  }

  const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/api/2024-01/graphql.json`;

  const query = `
    {
      products(first: 50) {
        edges {
          node {
            id
            handle
            title
            description
            onlineStoreUrl
            images(first: 1) {
              edges {
                node {
                  url
                  altText
                }
              }
            }
          }
        }
      }
    }
  `;

  const headers = {
    "Content-Type": "application/json",
  };

  if (SHOPIFY_STOREFRONT_TOKEN) {
    headers["X-Shopify-Storefront-Access-Token"] = SHOPIFY_STOREFRONT_TOKEN;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("Error Shopify:", resp.status, txt);
    throw new Error("No se pudieron obtener los productos de Shopify");
  }

  const json = await resp.json();
  const edges = json?.data?.products?.edges || [];

  const products = edges.map((edge) => {
    const node = edge.node;
    const imgEdge = node.images?.edges?.[0];
    const img = imgEdge?.node;
    const imageUrl =
      img?.url || "https://via.placeholder.com/400x400?text=Producto";

    const handle = node.handle;
    const url =
      node.onlineStoreUrl ||
      `https://${SHOPIFY_STORE_DOMAIN}/products/${handle}`;

    return {
      id: handle, // usamos handle como id para el front
      handle,
      title: node.title,
      description: node.description || "",
      image: imageUrl,
      url,
    };
  });

  return products;
}

// ========= REPLICATE SDXL (B) =========

async function llamarReplicateImagen(roomImageUrl, productName, idea) {
  if (!process.env.REPLICATE_API_TOKEN) {
    console.warn("REPLICATE_API_TOKEN no definido, devolviendo placeholder.");
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }

  // Prompt centrado en interior + producto + mantener habitación
  const prompt =
    `Photorealistic interior photograph of the SAME room as the reference image. ` +
    `Maintain the original walls, colors, furniture and perspective. ` +
    `Add the decoration product "${productName}" on a visible wall in a natural, realistic way, with correct scale and alignment. ` +
    (idea && idea.trim().length > 0
      ? `Client request: "${idea.trim()}". Respect this composition as much as possible. `
      : `Balanced, minimalistic and premium composition, centered around the product. `) +
    `Soft warm lighting, 4k, high detail. No text, no watermark, no logo.`;

  const negativePrompt =
    "low quality, blurry, distorted, deformed, bad anatomy, wrong perspective, extra limbs, text, watermark, logo, oversaturated, cartoon";

  try {
    const output = await replicate.run(
      // Versión estable de SDXL recomendada en la doc oficial
      // https://replicate.com/stability-ai/sdxl :contentReference[oaicite:1]{index=1}
      "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
      {
        input: {
          prompt,
          negative_prompt: negativePrompt,
          // img2img: usamos la imagen del cliente como referencia
          image: roomImageUrl, // URL pública (Cloudinary)
          strength: 0.55, // 0.0 = copia exacta, 1.0 = ignora la foto
          num_inference_steps: 28,
          guidance_scale: 7.5,
          scheduler: "K_EULER",
          refine: "expert_ensemble_refiner",
          lora_scale: 0, // sin LoRA por ahora
          num_outputs: 1,
          // output_format por defecto URL
        },
      }
    );

    if (Array.isArray(output) && output.length > 0) {
      return output[0];
    }

    console.warn("Replicate devolvió output vacío:", output);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  } catch (err) {
    console.error("Error llamando a Replicate SDXL:", err);
    return "https://via.placeholder.com/1024x1024?text=Propuesta+IA";
  }
}

// ========= RUTAS =========

// Healthcheck
app.get("/", (req, res) => {
  res.send("Innotiva Backend con Replicate SDXL (B) OK ✅");
});

// Productos para el formulario
app.get("/productos-shopify", async (req, res) => {
  try {
    const products = await llamarShopifyProducts();
    return res.json({ success: true, products });
  } catch (err) {
    console.error("ERR /productos-shopify:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Experiencia premium: foto + producto + idea
app.post(
  "/experiencia-premium",
  upload.single("roomImage"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Falta la imagen del espacio (roomImage)",
        });
      }

      const { productId, productName, idea, productUrl } = req.body;

      if (!productId || !productName) {
        return res.status(400).json({
          success: false,
          error: "Faltan datos del producto (productId / productName)",
        });
      }

      // 1) Subir la foto original del cliente a Cloudinary
      const userImageUrl = await subirACloudinaryDesdeBuffer(
        req.file.buffer,
        "innotiva/rooms",
        "room"
      );

      // 2) Generar imagen IA con Replicate (img2img)
      const generatedImageUrl = await llamarReplicateImagen(
        userImageUrl,
        productName,
        idea || ""
      );

      // 3) Resolver URL final del producto
      let finalProductUrl = productUrl || null;
      if (!finalProductUrl) {
        // productId lo estamos usando como handle (ver /productos-shopify)
        finalProductUrl = `https://${SHOPIFY_STORE_DOMAIN}/products/${productId}`;
      }

      // 4) Mensaje para la página de resultado
      const message = generarMensajePersonalizado(productName, idea);

      return res.json({
        success: true,
        message,
        userImageUrl,
        generatedImageUrl,
        productUrl: finalProductUrl,
        productName,
      });
    } catch (err) {
      console.error("ERR /experiencia-premium:", err);
      return res.status(500).json({
        success: false,
        error: "Error interno preparando la experiencia premium",
      });
    }
  }
);

// ========= ARRANCAR SERVIDOR =========

app.listen(port, () => {
  console.log(
    `Servidor Innotiva con Replicate SDXL (B) escuchando en puerto ${port}`
  );
});
