/* global afterEach, describe, it, expect, jest */
const initialEnv = Object.assign({}, process.env)

afterEach(() => {
  process.env = initialEnv
  jest.resetModules()
})

const loadWithMockedSSM = () => {
  const commands = []

  jest.doMock('@aws-sdk/client-ssm', () => ({
    SSMClient: class {
      async send(command) {
        commands.push(command)
        return {
          Parameters: [{ Name: `${command.Names[0]}`, Value: 'curvo' }]
        }
      }
    },
    GetParametersCommand: class {
      constructor(input) {
        this.Names = input.Names
      }
    }
  }))

  return { commands, ...require('../lib/ssm') }
}

describe('SSM', () => {
  it('reads parameters from the configured prefix', async () => {
    process.env = { SSM_PARAMETER_PREFIX: '/custom/prefix' }
    const { commands, loadSSMParameters } = loadWithMockedSSM()

    await loadSSMParameters()

    expect(commands[0].Names).toEqual([
      '/custom/prefix/ACCOUNT',
      '/custom/prefix/REPOSITORY',
      '/custom/prefix/TOKEN'
    ])
  })

  it('falls back to the default prefix', async () => {
    process.env = {}
    const { commands, loadSSMParameters } = loadWithMockedSSM()

    await loadSSMParameters()

    expect(commands[0].Names[0]).toBe('/sst/hazel/production/secrets/ACCOUNT')
  })
})
