///
/// IMPORTS
///

import { DynamoDB, HandledError, ResourceController } from 'idea-aws';

import { Message, MessageTypes, QueueMoves } from '../models/message.model';
import { Topic, TopicTypes } from '../models/topic.model';
import { User } from '../models/user.model';
import { Subject } from '../models/subject.model';
import { Configurations } from '../models/configurations.model';

///
/// CONSTANTS, ENVIRONMENT VARIABLES, HANDLER
///

const DDB_TABLES = {
  messages: process.env.DDB_TABLE_messages,
  topics: process.env.DDB_TABLE_topics,
  configurations: process.env.DDB_TABLE_configurations
};
const ddb = new DynamoDB();

export const handler = (ev: any, _: any, cb: any): Promise<void> => new MessagesRC(ev, cb).handleRequest();

///
/// RESOURCE CONTROLLER
///

class MessagesRC extends ResourceController {
  galaxyUser: User;
  topic: Topic;
  message: Message;

  constructor(event: any, callback: any) {
    super(event, callback, { resourceId: 'messageId' });
    this.galaxyUser = new User(event.requestContext.authorizer.lambda.user);
  }

  protected async checkAuthBeforeRequest(): Promise<void> {
    try {
      this.topic = new Topic(
        await ddb.get({ TableName: DDB_TABLES.topics, Key: { topicId: this.pathParameters.topicId } })
      );
    } catch (err) {
      throw new HandledError('Topic not found');
    }

    if (this.topic.type !== TopicTypes.LIVE) throw new HandledError('Incompatible type of topic');

    if (!this.resourceId) return;

    try {
      this.message = new Message(
        await ddb.get({
          TableName: DDB_TABLES.messages,
          Key: { topicId: this.pathParameters.topicId, messageId: this.resourceId }
        })
      );
    } catch (err) {
      throw new HandledError('Message not found');
    }

    if (!this.galaxyUser.isAdministrator && this.message.creator?.id !== this.galaxyUser.userId)
      throw new HandledError('Unauthorized');
  }

  protected async getResources(): Promise<Message[]> {
    let messages: Message[] = await ddb.query({
      TableName: DDB_TABLES.messages,
      KeyConditionExpression: 'topicId = :topicId',
      ExpressionAttributeValues: { ':topicId': this.topic.topicId }
    });
    messages = messages.map(x => new Message(x));
    return messages.sort((a, b): number => b.createdAt.localeCompare(a.createdAt));
  }

  protected async postResources(): Promise<Message> {
    if (!this.topic.canUserInteract(this.galaxyUser)) throw new Error('Not allowed to interact');

    const { bannedUsersIds } = new Configurations(
      await ddb.get({ TableName: DDB_TABLES.configurations, Key: { PK: Configurations.PK } })
    );
    if (bannedUsersIds.includes(this.galaxyUser.userId)) throw new Error('User is banned');

    this.message = new Message(this.body);
    this.message.topicId = this.topic.topicId;
    this.message.messageId = Message.getPK(this.galaxyUser.userId);
    this.message.creator = Subject.fromUser(this.galaxyUser);
    this.message.createdAt = new Date().toISOString();
    this.message.numOfUpvotes = 0;
    this.message.setQueuePositionForNewMessage(await this.getResources());

    const errors = this.message.validate(this.topic);
    if (errors.length) throw new HandledError(`Invalid fields: ${errors.join(', ')}`);

    await ddb.put({
      TableName: DDB_TABLES.messages,
      Item: this.message,
      ConditionExpression: 'attribute_not_exists(topicId) AND attribute_not_exists(messageId)'
    });

    return this.message;
  }

  protected async deleteResource(): Promise<void> {
    if (this.topic.isArchived()) throw new Error('Topic is archived');

    await ddb.delete({
      TableName: DDB_TABLES.messages,
      Key: { topicId: this.topic.topicId, messageId: this.message.messageId }
    });
  }

  protected async patchResource(): Promise<Message> {
    if (Object.values(QueueMoves).includes(this.body.action)) return await this.moveInQueue(this.body.action);

    switch (this.body.action) {
      case 'MARK_COMPLETE':
        return await this.markComplete();
      case 'UNDO_COMPLETE':
        return await this.undoComplete();
      default:
        throw new HandledError('Unsupported action');
    }
  }
  private async markComplete(): Promise<Message> {
    if (this.topic.isArchived()) throw new Error('Topic is archived');
    if (this.message.completedAt) throw new Error('Message is already complete');

    this.message.completedAt = new Date().toISOString();
    await ddb.update({
      TableName: DDB_TABLES.messages,
      Key: { topicId: this.topic.topicId, messageId: this.resourceId },
      UpdateExpression: 'SET completedAt = :completedAt',
      ExpressionAttributeValues: { ':completedAt': this.message.completedAt }
    });

    return this.message;
  }
  private async undoComplete(): Promise<Message> {
    if (this.topic.isArchived()) throw new Error('Topic is archived');
    if (!this.galaxyUser.isAdministrator) throw new Error('Unauthorized');

    if (!this.message.completedAt) return this.message;

    delete this.message.completedAt;
    await ddb.update({
      TableName: DDB_TABLES.messages,
      Key: { topicId: this.topic.topicId, messageId: this.resourceId },
      UpdateExpression: 'REMOVE completedAt'
    });

    return this.message;
  }

  private async moveInQueue(move: QueueMoves): Promise<Message> {
    if (this.topic.isArchived()) throw new Error('Topic is archived');
    if (!this.galaxyUser.isAdministrator) throw new Error('Unauthorized');
    if (this.message.type !== MessageTypes.QUESTION) throw new HandledError('Only questions can be moved');
    if (this.message.completedAt) throw new HandledError('Message is already complete');

    const queue = (await this.getResources())
      .filter(x => x.type === MessageTypes.QUESTION && !x.completedAt)
      .sort(Message.compareByQueue);
    const currentRound = queue.filter(x => x.round === this.message.round);
    const index = currentRound.findIndex(x => x.messageId === this.message.messageId);
    const isFirst = index === 0;
    const isLast = index === currentRound.length - 1;

    switch (move) {
      case QueueMoves.UP:
        if (isFirst) return this.message;
        return await this.swapPositionInQueue(currentRound[index - 1], -1);
      case QueueMoves.DOWN:
        if (isLast) return this.message;
        return await this.swapPositionInQueue(currentRound[index + 1], 1);
      case QueueMoves.TOP:
        if (isFirst) return this.message;
        return await this.setPositionInQueue(this.message.round, currentRound[0].getQueueOrder() - 1);
      case QueueMoves.BOTTOM:
        if (isLast) return this.message;
        return await this.setPositionInQueue(
          this.message.round,
          currentRound[currentRound.length - 1].getQueueOrder() + 1
        );
      case QueueMoves.PREVIOUS_ROUND:
        if (this.message.round === 0) throw new HandledError('Already in the first round');
        return await this.setPositionInQueue(this.message.round - 1, this.getEndOfRound(queue, this.message.round - 1));
      case QueueMoves.NEXT_ROUND:
        return await this.setPositionInQueue(this.message.round + 1, this.getEndOfRound(queue, this.message.round + 1));
    }
  }
  private getEndOfRound(queue: Message[], round: number): number {
    const ofRound = queue.filter(x => x.round === round);
    const lastOfRound = ofRound[ofRound.length - 1];
    return lastOfRound ? lastOfRound.getQueueOrder() + 1 : Date.now();
  }
  private async setPositionInQueue(round: number, queueOrder: number): Promise<Message> {
    this.message.round = round;
    this.message.queueOrder = queueOrder;
    await ddb.update({
      TableName: DDB_TABLES.messages,
      Key: { topicId: this.topic.topicId, messageId: this.message.messageId },
      UpdateExpression: 'SET #round = :round, queueOrder = :queueOrder',
      ExpressionAttributeNames: { '#round': 'round' },
      ExpressionAttributeValues: { ':round': round, ':queueOrder': queueOrder }
    });
    return this.message;
  }
  /**
   * Swap the position of the current message with an adjacent one in the same round.
   * @param direction -1 if the other message comes before the current one, 1 if it comes after
   */
  private async swapPositionInQueue(other: Message, direction: -1 | 1): Promise<Message> {
    const otherQueueOrder = other.getQueueOrder();
    let thisQueueOrder = this.message.getQueueOrder();
    // in the (rare) case of a tie, make sure the swap actually changes the order
    if (thisQueueOrder === otherQueueOrder) thisQueueOrder = otherQueueOrder - direction;

    const update = (messageId: string, queueOrder: number): any => ({
      Update: {
        TableName: DDB_TABLES.messages,
        Key: { topicId: this.topic.topicId, messageId },
        UpdateExpression: 'SET queueOrder = :queueOrder',
        ExpressionAttributeValues: { ':queueOrder': queueOrder }
      }
    });
    await ddb.transactWrites([
      update(this.message.messageId, otherQueueOrder),
      update(other.messageId, thisQueueOrder)
    ]);

    this.message.queueOrder = otherQueueOrder;
    return this.message;
  }
}
