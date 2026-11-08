const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm')

const DEFAULT_SSM_PARAMETER_PREFIX = '/sst/hazel/production/secrets'

const PARAMETER_NAMES = ['ACCOUNT', 'REPOSITORY', 'TOKEN']

async function loadSSMParameters() {
  // Skip SSM loading if running locally or if parameters already exist
  if (process.env.USE_LOCAL_ENV === 'true') {
    console.log('Using local environment variables, skipping SSM')
    return
  }

  // If all required params already exist in env, skip SSM
  if (process.env.ACCOUNT && process.env.REPOSITORY) {
    console.log('Environment variables already set, skipping SSM')
    return
  }

  try {
    const client = new SSMClient({})

    const prefix =
      process.env.SSM_PARAMETER_PREFIX || DEFAULT_SSM_PARAMETER_PREFIX
    const parameterPaths = PARAMETER_NAMES.map(name => `${prefix}/${name}`)

    console.log('Loading parameters from SSM:', parameterPaths)

    const command = new GetParametersCommand({
      Names: parameterPaths,
      WithDecryption: true
    })

    const response = await client.send(command)

    if (!response.Parameters || response.Parameters.length === 0) {
      throw new Error('No parameters returned from SSM')
    }

    // Map parameters to environment variables
    for (const param of response.Parameters) {
      const paramName = param.Name.split('/').pop()
      const paramValue = param.Value

      if (paramValue) {
        process.env[paramName] = paramValue
        console.log(`Loaded SSM parameter: ${paramName}`)
      }
    }

    // Log any missing parameters
    if (response.InvalidParameters && response.InvalidParameters.length > 0) {
      console.warn('Missing SSM parameters:', response.InvalidParameters)
    }

    console.log('SSM parameters loaded successfully')
  } catch (error) {
    console.error('Error loading SSM parameters:', error.message)
    throw error
  }
}

module.exports = { loadSSMParameters }
