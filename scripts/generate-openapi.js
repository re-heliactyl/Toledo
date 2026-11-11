 const fs = require('fs');
 const path = require('path');
 const { generateOpenApiSpec } = require('../handlers/openapi');
 
 console.log('Generating OpenAPI 3.1 specification from Zod schemas and routes...');
 const spec = generateOpenApiSpec();
 const json = JSON.stringify(spec, null, 2);
 
 // 1. Save in server-toledo/openapi.json
 const serverOutputPath = path.join(__dirname, '..', 'openapi.json');
 fs.writeFileSync(serverOutputPath, json, 'utf8');
 console.log('✓ Saved: ' + serverOutputPath);
 
 // 2. Save in root toledo/openapi.json
 const rootOutputPath = path.join(__dirname, '..', '..', 'openapi.json');
 fs.writeFileSync(rootOutputPath, json, 'utf8');
 console.log('✓ Saved: ' + rootOutputPath);
 
 console.log('Summary:');
 console.log('  OpenAPI Version: ' + spec.openapi);
 console.log('  Total Endpoints: ' + Object.keys(spec.paths).length);
 console.log('  Total Schemas:   ' + Object.keys(spec.components.schemas).length);
 console.log('OpenAPI 3.1 specification successfully generated!');
